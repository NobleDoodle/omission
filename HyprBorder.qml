import QtQuick
import QtQuick.Shapes
import "WindowModel.js" as WindowModel

// Hyprland's window border, drawn the way Hyprland draws it: border_size
// outside the frame, corners on the rounding / rounding_power curve, and
// every col.*_border gradient stop laid out by Hyprland's own angle formula.
// Size it to the border box: the window's frame plus `thickness` per side.
Item {
  id: root

  property real innerRadius: 0
  property real thickness: 0
  property real roundingPower: 2
  // "#aarrggbb" stops, as WindowModel.hyprBorderGradient returns them.
  property var colors: []
  property real angle: 0

  readonly property var line: WindowModel.hyprGradientLine(width, height, angle)
  readonly property string path: WindowModel.hyprBorderPath(width, height,
    innerRadius, thickness, roundingPower)

  // Hyprland spreads n stops evenly over the progress; unused slots repeat
  // the last stop at the end of the line.
  function stopPosition(index) {
    var count = root.colors.length
    if (count < 2) return index === 0 ? 0 : 1
    return index < count ? index / (count - 1) : 1
  }

  function stopColor(index) {
    var count = root.colors.length
    if (count === 0) return "transparent"
    return root.colors[Math.min(index, count - 1)]
  }

  visible: path !== "" && colors.length > 0

  Shape {
    anchors.fill: parent
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      strokeWidth: -1
      strokeColor: "transparent"
      fillRule: ShapePath.OddEvenFill
      fillGradient: LinearGradient {
        x1: root.line.x1
        y1: root.line.y1
        x2: root.line.x2
        y2: root.line.y2
        GradientStop { position: root.stopPosition(0); color: root.stopColor(0) }
        GradientStop { position: root.stopPosition(1); color: root.stopColor(1) }
        GradientStop { position: root.stopPosition(2); color: root.stopColor(2) }
        GradientStop { position: root.stopPosition(3); color: root.stopColor(3) }
        GradientStop { position: root.stopPosition(4); color: root.stopColor(4) }
        GradientStop { position: root.stopPosition(5); color: root.stopColor(5) }
        GradientStop { position: root.stopPosition(6); color: root.stopColor(6) }
        GradientStop { position: root.stopPosition(7); color: root.stopColor(7) }
        GradientStop { position: root.stopPosition(8); color: root.stopColor(8) }
        GradientStop { position: root.stopPosition(9); color: root.stopColor(9) }
      }

      PathSvg { path: root.path }
    }
  }
}
