import QtQuick
import qs.Commons

// One space drawn in a bar indicator style. The bar widget wraps it in a
// button; the overview's settings panel draws it as that style's preview.
// "dots" follows Workspace Dots by Voyagen (MIT): 8 px dots, the focused
// space grown into a 16 px accent pill over 90 ms.
Item {
  id: root

  property string style: "numbers"
  property bool focused: false
  property bool occupied: false
  property string label: ""
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color accentText: Color.background
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.body
  property bool vertical: false
  property real unit: 1

  readonly property bool textual: style === "numbers" || style === "pills"
  // Dots and lines lie along the bar, so a vertical bar turns them upright.
  readonly property bool upright: vertical && !textual

  function px(value) { return Style.spaceReal(value) * root.unit }

  readonly property real along: style === "dots" ? px(focused ? 16 : 8)
    : style === "lines" ? px(focused ? 22 : 12)
    : style === "pills" ? Math.max(px(20), labelText.implicitWidth + px(14))
    : labelText.implicitWidth
  readonly property real across: style === "dots" ? px(8)
    : style === "lines" ? px(3)
    : style === "pills" ? px(18)
    : labelText.implicitHeight

  implicitWidth: upright ? across : along
  implicitHeight: upright ? along : across

  Behavior on implicitWidth {
    enabled: !root.textual
    NumberAnimation { duration: 90; easing.type: Easing.InOutSine }
  }
  Behavior on implicitHeight {
    enabled: !root.textual
    NumberAnimation { duration: 90; easing.type: Easing.InOutSine }
  }

  Rectangle {
    anchors.fill: parent
    visible: root.style !== "numbers"
    radius: Math.min(width, height) / 2
    color: root.focused ? root.accent
      : root.style === "pills"
        ? (root.occupied ? Util.alpha(root.foreground, 0.14) : "transparent")
        : root.foreground
    opacity: root.focused || root.style === "pills" ? 1
      : root.style === "dots" ? 0.7
      : root.occupied ? 0.7 : 0.3
    border.width: root.style === "pills" && !root.focused && !root.occupied ? 1 : 0
    border.color: Util.alpha(root.foreground, 0.35)

    Behavior on color { ColorAnimation { duration: 90 } }
    Behavior on opacity { NumberAnimation { duration: 90 } }
  }

  Text {
    id: labelText
    anchors.centerIn: parent
    visible: root.textual
    text: root.label
    color: root.style === "pills" && root.focused ? root.accentText : root.foreground
    opacity: root.focused || root.occupied ? 1 : 0.5
    font.family: root.fontFamily
    font.pixelSize: root.style === "pills" ? root.fontSize * 0.86 : root.fontSize
    font.weight: root.style === "pills" ? Font.DemiBold : Font.Normal
  }
}
