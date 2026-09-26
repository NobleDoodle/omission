#include <errno.h>
#include <fcntl.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int emit_event(int fd, unsigned short type, unsigned short code, int value) {
  struct input_event event = {0};
  event.type = type;
  event.code = code;
  event.value = value;
  return write(fd, &event, sizeof(event)) == (ssize_t)sizeof(event) ? 0 : -1;
}

static int sync_events(int fd) { return emit_event(fd, EV_SYN, SYN_REPORT, 0); }

static int set_key(int fd, unsigned short code, int value) {
  return emit_event(fd, EV_KEY, code, value) || sync_events(fd);
}

static int tap_key(int fd, unsigned short code) {
  if (set_key(fd, code, 1)) return -1;
  usleep(30000);
  return set_key(fd, code, 0);
}

static void release_modifiers(int fd) {
  set_key(fd, KEY_LEFTSHIFT, 0);
  set_key(fd, KEY_LEFTALT, 0);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "forward";
  if (strcmp(mode, "forward") && strcmp(mode, "reverse")
      && strcmp(mode, "escape") && strcmp(mode, "reload")) {
    fprintf(stderr, "usage: %s forward|reverse|escape|reload\n", argv[0]);
    return 64;
  }

  int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0) {
    fprintf(stderr, "open /dev/uinput: %s\n", strerror(errno));
    return 1;
  }
  if (ioctl(fd, UI_SET_EVBIT, EV_KEY) < 0) {
    fprintf(stderr, "configure uinput: %s\n", strerror(errno));
    close(fd);
    return 1;
  }
  for (unsigned int code = 1; code <= KEY_MAX; ++code) {
    if (ioctl(fd, UI_SET_KEYBIT, code) < 0) {
      fprintf(stderr, "configure key %u: %s\n", code, strerror(errno));
      close(fd);
      return 1;
    }
  }

  struct uinput_setup setup = {0};
  snprintf(setup.name, UINPUT_MAX_NAME_SIZE, "omission-alt-tab-live-smoke");
  setup.id.bustype = BUS_USB;
  setup.id.vendor = 0x1;
  setup.id.product = 0x2;
  setup.id.version = 1;
  if (ioctl(fd, UI_DEV_SETUP, &setup) < 0 || ioctl(fd, UI_DEV_CREATE) < 0) {
    fprintf(stderr, "create uinput device: %s\n", strerror(errno));
    close(fd);
    return 1;
  }

  sleep(2);
  if (set_key(fd, KEY_LEFTALT, 1)) goto send_error;
  if (!strcmp(mode, "reverse") && set_key(fd, KEY_LEFTSHIFT, 1)) goto send_error;
  if (tap_key(fd, KEY_TAB)) goto send_error;
  usleep(180000);

  if (!strcmp(mode, "escape")) {
    if (tap_key(fd, KEY_ESC)) goto send_error;
  } else if (strcmp(mode, "reload")) {
    if (tap_key(fd, KEY_TAB)) goto send_error;
  }

  if (!strcmp(mode, "reload")) sleep(5);
  else sleep(2);
  release_modifiers(fd);
  usleep(250000);
  ioctl(fd, UI_DEV_DESTROY);
  close(fd);
  return 0;

send_error:
  fprintf(stderr, "send input: %s\n", strerror(errno));
  release_modifiers(fd);
  ioctl(fd, UI_DEV_DESTROY);
  close(fd);
  return 1;
}
