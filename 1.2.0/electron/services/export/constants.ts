/**
 * 微信 4.x 中文件类 appmsg 消息的 localType 变体集合。
 *
 * 49 是通用 appmsg 容器（需再解析 XML 的 appmsg type 才能区分文件/转账/红包），
 * 其余变体在实测中几乎专用于文件附件。
 */
export const FILE_APP_LOCAL_TYPE_SET: ReadonlySet<number> = new Set([
  49,
  34359738417,
  103079215153,
  25769803825
])
