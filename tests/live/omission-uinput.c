/*
 * omission-uinput - minimal /dev/uinput injector used by the Omission
 * live interaction tests.
 *
 * Pointer commands (click, double-click, move, drag) create a fresh
 * relative mouse; key commands (key, chord) create a fresh keyboard;
 * swipe-up creates an absolute multitouch touchpad (INPUT_PROP_POINTER,
 * BTN_TOUCH/BTN_TOOL_FINGER/BTN_TOOL_TRIPLETAP, ABS_X/Y and ABS_MT
 * slots/positions/tracking ids) and injects a three-finger upward swipe,
 * releasing every slot.  Stepped motion uses cumulative integer targets so
 * the requested DX/DY totals are emitted exactly.  Held buttons and
 * modifiers are always released on normal paths.
 *
 * Any failure (bad arguments, /dev/uinput access, ioctl, write) exits
 * nonzero with a concise message on stderr.  swipe-up in particular exits
 * nonzero when the touchpad cannot be created (e.g. kernel/uinput refuses
 * a required capability), so callers can record gesture registration as
 * manual evidence instead.
 *
 * Usage:
 *   omission-uinput click
 *   omission-uinput double-click
 *   omission-uinput move DX DY STEPS DURATION_MS
 *   omission-uinput drag DX DY STEPS DURATION_MS
 *   omission-uinput key NAME
 *   omission-uinput chord MOD KEY
 *   omission-uinput swipe-up
 *
 * NAME: h j k l q escape esc left right up down tab enter 1-9
 *       (case-insensitive)
 * MOD:  shift ctrl
 *
 * Build: cc -O2 -Wall -Wextra -Werror -o omission-uinput omission-uinput.c
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#define PROG       "omission-uinput"
#define UINPUT_DEV "/dev/uinput"

/* timings, in milliseconds */
#define SETTLE_MS   200  /* compositor attaches the fresh device      */
#define PRESS_MS     60  /* key/button hold time                      */
#define GAP_MS      100  /* double-click gap, touch settle, mod order */
#define RELEASE_MS   30  /* settle after a release before teardown    */

/* touchpad geometry and swipe shape */
#define TP_MIN        0
#define TP_MAX     1000
#define TP_RES       25  /* units per mm, for libinput distance maths */
#define SWIPE_DIST  600  /* total upward travel, ~24mm               */
#define SWIPE_FRAMES 25
#define SWIPE_FRAME_MS 12

struct key_def {
    const char   *name;
    unsigned int  code;
};

/* Keys and modifiers accepted by key/chord (matched case-insensitively). */
static const struct key_def key_defs[] = {
    { "h",      KEY_H          },
    { "j",      KEY_J          },
    { "k",      KEY_K          },
    { "l",      KEY_L          },
    { "q",      KEY_Q          },
    { "escape", KEY_ESC        },
    { "esc",    KEY_ESC        },
    { "left",   KEY_LEFT       },
    { "right",  KEY_RIGHT      },
    { "up",     KEY_UP         },
    { "down",   KEY_DOWN       },
    { "tab",    KEY_TAB        },
    { "enter",  KEY_ENTER      },
    { "1",      KEY_1          },
    { "2",      KEY_2          },
    { "3",      KEY_3          },
    { "4",      KEY_4          },
    { "5",      KEY_5          },
    { "6",      KEY_6          },
    { "7",      KEY_7          },
    { "8",      KEY_8          },
    { "9",      KEY_9          },
    { "shift",  KEY_LEFTSHIFT  },
    { "ctrl",   KEY_LEFTCTRL   },
};

static int ufd = -1;

static void die(const char *fmt, ...)
    __attribute__((format(printf, 1, 2), noreturn));

static void die(const char *fmt, ...)
{
    va_list ap;

    fprintf(stderr, "%s: ", PROG);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    exit(1);
}

static void usage(void)
    __attribute__((noreturn));

static void usage(void)
{
    fprintf(stderr,
        "usage: " PROG " click\n"
        "       " PROG " double-click\n"
        "       " PROG " move DX DY STEPS DURATION_MS\n"
        "       " PROG " drag DX DY STEPS DURATION_MS\n"
        "       " PROG " key NAME\n"
        "       " PROG " chord MOD KEY\n"
        "       " PROG " swipe-up\n"
        "NAME: h j k l q escape esc left right up down tab enter 1-9\n"
        "MOD:  shift ctrl\n");
    exit(2);
}

static void die_errno(const char *what)
{
    die("%s: %s", what, strerror(errno));
}

static void sleep_ms(long ms)
{
    struct timespec ts;

    if (ms <= 0)
        return;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (ms % 1000) * 1000000L;
    while (nanosleep(&ts, &ts) < 0 && errno == EINTR)
        continue;
}

static long parse_long(const char *s, const char *what)
{
    char *end;
    long v;

    errno = 0;
    v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0')
        die("invalid %s: '%s'", what, s);
    return v;
}

static int parse_int(const char *s, const char *what)
{
    long v = parse_long(s, what);

    if (v < INT_MIN || v > INT_MAX)
        die("%s out of range: '%s'", what, s);
    return (int)v;
}

static unsigned int find_key(const char *name, const char *what)
{
    size_t i;

    for (i = 0; i < sizeof(key_defs) / sizeof(key_defs[0]); i++)
        if (strcasecmp(key_defs[i].name, name) == 0)
            return key_defs[i].code;
    die("unknown %s: '%s'", what, name);
}

static unsigned int find_mod(const char *name)
{
    if (strcasecmp(name, "shift") == 0)
        return KEY_LEFTSHIFT;
    if (strcasecmp(name, "ctrl") == 0)
        return KEY_LEFTCTRL;
    die("unknown MOD: '%s' (expected shift or ctrl)", name);
}

static void emit(unsigned short type, unsigned short code, int value)
{
    struct input_event ev;

    memset(&ev, 0, sizeof(ev));
    ev.type = type;
    ev.code = code;
    ev.value = value;
    if (write(ufd, &ev, sizeof(ev)) != (ssize_t)sizeof(ev))
        die_errno("write " UINPUT_DEV);
}

static void sync_report(void)
{
    emit(EV_SYN, SYN_REPORT, 0);
}

static int open_uinput(void)
{
    int fd = open(UINPUT_DEV, O_WRONLY);

    if (fd < 0)
        die_errno("open " UINPUT_DEV);
    return fd;
}

static void finish_setup(int fd, const char *name, unsigned short product)
{
    struct uinput_setup setup;

    memset(&setup, 0, sizeof(setup));
    snprintf(setup.name, sizeof(setup.name), "%s", name);
    setup.id.bustype = BUS_USB;
    setup.id.vendor = 0x6f6d; /* "om" */
    setup.id.product = product;
    setup.id.version = 1;

    if (ioctl(fd, UI_DEV_SETUP, &setup) < 0)
        die_errno("ioctl UI_DEV_SETUP");
    if (ioctl(fd, UI_DEV_CREATE) < 0)
        die_errno("ioctl UI_DEV_CREATE");
    /* Give the compositor time to open the new device before injecting. */
    sleep_ms(SETTLE_MS);
}

static void destroy_device(void)
{
    if (ioctl(ufd, UI_DEV_DESTROY) < 0)
        die_errno("ioctl UI_DEV_DESTROY");
    close(ufd);
    ufd = -1;
}

static int create_mouse(void)
{
    int fd = open_uinput();

    if (ioctl(fd, UI_SET_EVBIT, EV_KEY) < 0 ||
        ioctl(fd, UI_SET_EVBIT, EV_REL) < 0)
        die_errno("ioctl UI_SET_EVBIT");
    if (ioctl(fd, UI_SET_KEYBIT, BTN_LEFT) < 0)
        die_errno("ioctl UI_SET_KEYBIT");
    if (ioctl(fd, UI_SET_RELBIT, REL_X) < 0 ||
        ioctl(fd, UI_SET_RELBIT, REL_Y) < 0)
        die_errno("ioctl UI_SET_RELBIT");
    finish_setup(fd, "omission-uinput mouse", 1);
    return fd;
}

static int create_keyboard(void)
{
    size_t i;
    int fd = open_uinput();

    if (ioctl(fd, UI_SET_EVBIT, EV_KEY) < 0)
        die_errno("ioctl UI_SET_EVBIT");
    for (i = 0; i < sizeof(key_defs) / sizeof(key_defs[0]); i++)
        if (ioctl(fd, UI_SET_KEYBIT, key_defs[i].code) < 0)
            die_errno("ioctl UI_SET_KEYBIT");
    finish_setup(fd, "omission-uinput keyboard", 2);
    return fd;
}

static void setup_abs_axis(int fd, unsigned short code, int min, int max,
                           int resolution)
{
    struct uinput_abs_setup abs;

    memset(&abs, 0, sizeof(abs));
    abs.code = code;
    abs.absinfo.minimum = min;
    abs.absinfo.maximum = max;
    abs.absinfo.resolution = resolution;
    if (ioctl(fd, UI_ABS_SETUP, &abs) < 0)
        die_errno("ioctl UI_ABS_SETUP");
}

/*
 * An absolute multitouch touchpad a libinput-based compositor classifies
 * as a pointer touchpad rather than a touchscreen: INPUT_PROP_POINTER,
 * BTN_TOUCH plus BTN_TOOL_FINGER/DOUBLETAP/TRIPLETAP capabilities, ABS_X/Y
 * and protocol-B ABS_MT slots/positions/tracking ids.
 */
static int create_touchpad(void)
{
    int fd = open_uinput();

    if (ioctl(fd, UI_SET_EVBIT, EV_KEY) < 0 ||
        ioctl(fd, UI_SET_EVBIT, EV_ABS) < 0)
        die_errno("ioctl UI_SET_EVBIT");
    if (ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_POINTER) < 0)
        die_errno("ioctl UI_SET_PROPBIT");
    if (ioctl(fd, UI_SET_KEYBIT, BTN_LEFT) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, BTN_TOUCH) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, BTN_TOOL_FINGER) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, BTN_TOOL_DOUBLETAP) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, BTN_TOOL_TRIPLETAP) < 0)
        die_errno("ioctl UI_SET_KEYBIT");
    setup_abs_axis(fd, ABS_X, TP_MIN, TP_MAX, TP_RES);
    setup_abs_axis(fd, ABS_Y, TP_MIN, TP_MAX, TP_RES);
    setup_abs_axis(fd, ABS_MT_SLOT, 0, 2, 0);
    setup_abs_axis(fd, ABS_MT_POSITION_X, TP_MIN, TP_MAX, TP_RES);
    setup_abs_axis(fd, ABS_MT_POSITION_Y, TP_MIN, TP_MAX, TP_RES);
    setup_abs_axis(fd, ABS_MT_TRACKING_ID, 0, 65535, 0);
    finish_setup(fd, "omission-uinput touchpad", 3);
    return fd;
}

static void run_click(void)
{
    ufd = create_mouse();
    emit(EV_KEY, BTN_LEFT, 1);
    sync_report();
    sleep_ms(PRESS_MS);
    emit(EV_KEY, BTN_LEFT, 0);
    sync_report();
    sleep_ms(RELEASE_MS);
    destroy_device();
}

static void run_double_click(void)
{
    int n;

    ufd = create_mouse();
    for (n = 0; n < 2; n++) {
        if (n > 0)
            sleep_ms(GAP_MS);
        emit(EV_KEY, BTN_LEFT, 1);
        sync_report();
        sleep_ms(PRESS_MS);
        emit(EV_KEY, BTN_LEFT, 0);
        sync_report();
    }
    sleep_ms(RELEASE_MS);
    destroy_device();
}

/*
 * Stepped relative motion.  Per-step targets are cumulative integer
 * fractions of the total, so the deltas sum to exactly DX and DY.
 */
static void run_motion(int dx, int dy, int steps, long ms, int hold_button)
{
    long step_ms = ms / steps;
    long long px = 0, py = 0;
    int i;

    ufd = create_mouse();
    if (hold_button) {
        emit(EV_KEY, BTN_LEFT, 1);
        sync_report();
        sleep_ms(GAP_MS);
    }
    for (i = 1; i <= steps; i++) {
        long long tx = (long long)dx * i / steps;
        long long ty = (long long)dy * i / steps;

        sleep_ms(step_ms);
        if (tx != px)
            emit(EV_REL, REL_X, (int)(tx - px));
        if (ty != py)
            emit(EV_REL, REL_Y, (int)(ty - py));
        sync_report();
        px = tx;
        py = ty;
    }
    if (hold_button) {
        sleep_ms(PRESS_MS);
        emit(EV_KEY, BTN_LEFT, 0);
        sync_report();
    }
    sleep_ms(RELEASE_MS);
    destroy_device();
}

static void run_key(unsigned int code)
{
    ufd = create_keyboard();
    emit(EV_KEY, code, 1);
    sync_report();
    sleep_ms(PRESS_MS);
    emit(EV_KEY, code, 0);
    sync_report();
    sleep_ms(RELEASE_MS);
    destroy_device();
}

static void run_chord(unsigned int mod, unsigned int code)
{
    ufd = create_keyboard();
    emit(EV_KEY, mod, 1);
    sync_report();
    sleep_ms(GAP_MS);
    emit(EV_KEY, code, 1);
    sync_report();
    sleep_ms(PRESS_MS);
    emit(EV_KEY, code, 0);
    sync_report();
    sleep_ms(GAP_MS);
    emit(EV_KEY, mod, 0);
    sync_report();
    sleep_ms(RELEASE_MS);
    destroy_device();
}

static void run_swipe_up(void)
{
    static const int start_x[3] = { 500, 450, 550 };
    static const int start_y[3] = { 700, 730, 760 };
    int f, i;

    ufd = create_touchpad();

    /* Three fingers touch down, one protocol-B slot each. */
    for (f = 0; f < 3; f++) {
        emit(EV_ABS, ABS_MT_SLOT, f);
        emit(EV_ABS, ABS_MT_TRACKING_ID, f + 1);
        emit(EV_ABS, ABS_MT_POSITION_X, start_x[f]);
        emit(EV_ABS, ABS_MT_POSITION_Y, start_y[f]);
    }
    emit(EV_KEY, BTN_TOUCH, 1);
    emit(EV_KEY, BTN_TOOL_TRIPLETAP, 1);
    sync_report();
    sleep_ms(GAP_MS);

    /* All fingers move upward; cumulative targets, exact total travel. */
    for (i = 1; i <= SWIPE_FRAMES; i++) {
        sleep_ms(SWIPE_FRAME_MS);
        for (f = 0; f < 3; f++) {
            emit(EV_ABS, ABS_MT_SLOT, f);
            emit(EV_ABS, ABS_MT_POSITION_Y,
                 start_y[f] - SWIPE_DIST * i / SWIPE_FRAMES);
        }
        sync_report();
    }

    /* Release every slot, then the buttons. */
    sleep_ms(PRESS_MS);
    for (f = 0; f < 3; f++) {
        emit(EV_ABS, ABS_MT_SLOT, f);
        emit(EV_ABS, ABS_MT_TRACKING_ID, -1);
    }
    emit(EV_KEY, BTN_TOOL_TRIPLETAP, 0);
    emit(EV_KEY, BTN_TOUCH, 0);
    sync_report();
    sleep_ms(RELEASE_MS);
    destroy_device();
}

static void expect_args(int argc, int want, const char *cmd)
{
    if (argc != want)
        die("wrong argument count for '%s' (need %d)", cmd, want - 2);
}

int main(int argc, char **argv)
{
    const char *cmd;

    if (argc < 2)
        usage();
    cmd = argv[1];

    if (strcmp(cmd, "click") == 0) {
        expect_args(argc, 2, cmd);
        run_click();
    } else if (strcmp(cmd, "double-click") == 0) {
        expect_args(argc, 2, cmd);
        run_double_click();
    } else if (strcmp(cmd, "move") == 0 || strcmp(cmd, "drag") == 0) {
        int drag = strcmp(cmd, "drag") == 0;
        int dx, dy, steps;
        long ms;

        expect_args(argc, 6, cmd);
        dx = parse_int(argv[2], "DX");
        dy = parse_int(argv[3], "DY");
        steps = parse_int(argv[4], "STEPS");
        ms = parse_long(argv[5], "DURATION_MS");
        if (steps < 1)
            die("STEPS must be >= 1");
        if (ms < 0)
            die("DURATION_MS must be >= 0");
        run_motion(dx, dy, steps, ms, drag);
    } else if (strcmp(cmd, "key") == 0) {
        expect_args(argc, 3, cmd);
        run_key(find_key(argv[2], "KEY"));
    } else if (strcmp(cmd, "chord") == 0) {
        expect_args(argc, 4, cmd);
        run_chord(find_mod(argv[2]), find_key(argv[3], "KEY"));
    } else if (strcmp(cmd, "swipe-up") == 0) {
        expect_args(argc, 2, cmd);
        run_swipe_up();
    } else {
        usage();
    }
    return 0;
}
