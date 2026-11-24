/** 本地图片小工具：机器人头像 / 聊天背景图都压成 data URL 存起来。
 *
 *  为什么不存原图：localStorage 只有 5 MB 左右，一张手机照片就塞满了；
 *  头像 128px 方图几 KB，背景图压到最多 1600×1000 一般 150–400 KB。
 *  背景图顺便从缩略图上取一个平均色，交给 CSS 给侧栏 / 聊天头染色。
 */

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("这个文件读不出来"));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("这不是一张能解码的图片"));
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function context2d(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前 WebView 不支持 canvas，换不了图");
  return context;
}

/** 方形头像：居中裁切 + 缩到 128px（JPEG 质量 0.9，通常 3–8 KB） */
export async function readAvatarImage(file: File): Promise<string> {
  const image = await loadImage(file);
  const size = 128;
  const context = context2d(size, size);
  const side = Math.min(image.width, image.height) || size;
  context.drawImage(
    image,
    (image.width - side) / 2,
    (image.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  return context.canvas.toDataURL("image/jpeg", 0.9);
}

export interface ChatBackgroundImage {
  /** 压好的 data URL */
  image: string;
  /** 虚化两档（选图时一起算好，切档位就不用再解码大图） */
  soft: string;
  strong: string;
  /** 平均色，"r g b"（给 `rgb(var(--chat-bg-tint) / α)` 用） */
  tint: string;
}

/** 虚化半径（按 1600×1000 的画布算，显示时差不多是 2/3 的观感） */
const BLUR_RADIUS = { soft: 10, strong: 26 } as const;

/** 聊天背景：等比缩到最多 1600×1000，压成 JPEG；再从 8×8 缩略图取平均色 */
export async function readChatBackground(file: File): Promise<ChatBackgroundImage> {
  const source = await loadImage(file);
  const maxWidth = 1600;
  const maxHeight = 1000;
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const context = context2d(width, height);
  context.drawImage(source, 0, 0, width, height);

  // 平均色：缩到 8×8 再逐像素累加，够用而且不用读完大图
  let tint = "110 168 254";
  const tiny = context2d(8, 8);
  tiny.drawImage(context.canvas, 0, 0, 8, 8);
  try {
    const { data } = tiny.getImageData(0, 0, 8, 8);
    let r = 0;
    let g = 0;
    let b = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    tint = `${Math.round(r / pixels)} ${Math.round(g / pixels)} ${Math.round(b / pixels)}`;
  } catch {
    // 取不到就用默认蓝，别让整张图白换
  }

  /** 拿平均色垫底再虚化：blur 会让边缘变透明，垫一层就不会露出面板底色 */
  const blurred = (radius: number) => {
    const layer = context2d(width, height);
    const [r, g, b] = tint.split(" ").map(Number);
    layer.fillStyle = `rgb(${r} ${g} ${b})`;
    layer.fillRect(0, 0, width, height);
    layer.filter = `blur(${radius}px)`;
    layer.drawImage(context.canvas, 0, 0, width, height);
    layer.filter = "none";
    return layer.canvas.toDataURL("image/jpeg", 0.8);
  };

  return {
    image: context.canvas.toDataURL("image/jpeg", 0.82),
    soft: blurred(BLUR_RADIUS.soft),
    strong: blurred(BLUR_RADIUS.strong),
    tint,
  };
}

/** 名字的首字（没有头像时当占位字）；空名字给 fallback */
export function initialOf(name: string, fallback = "A"): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : fallback;
}
