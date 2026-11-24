import { startResizeDragging, type ResizeDirection } from "../desktop/bridge";

const HANDLES: { direction: ResizeDirection; className: string }[] = [
  { direction: "North", className: "resize-handle n" },
  { direction: "South", className: "resize-handle s" },
  { direction: "West", className: "resize-handle w" },
  { direction: "East", className: "resize-handle e" },
  { direction: "NorthWest", className: "resize-handle nw" },
  { direction: "NorthEast", className: "resize-handle ne" },
  { direction: "SouthWest", className: "resize-handle sw" },
  { direction: "SouthEast", className: "resize-handle se" },
];

interface ResizeHandlesProps {
  /** 最大化时不需要缩放，直接不渲染（也避免误触） */
  disabled: boolean;
}

/**
 * 无边框窗口的八向缩放热区。
 *
 * 热区贴着窗口四边，鼠标按下时调用 Tauri 的 `startResizeDragging`，由系统完成缩放；
 * 边缘只留 4px，避免挡住右侧滚动条。
 */
export default function ResizeHandles({ disabled }: ResizeHandlesProps) {
  if (disabled) return null;

  return (
    <div className="resize-layer" aria-hidden="true">
      {HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          className={className}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void startResizeDragging(direction);
          }}
        />
      ))}
    </div>
  );
}
