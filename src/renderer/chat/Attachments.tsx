import type { Attachment } from '../../shared'
import { api } from '../api'

/** The URL the shell serves a conversation file at (familiar-file protocol, read-only). */
export const attachmentUrl = (a: Attachment) =>
  `familiar-file://localhost/${a.path.split('/').map(encodeURIComponent).join('/')}`

/** A short type label: the extension, or 文件 when there is none. */
export const fileKind = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1
    ? name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 4)
    : '文件'
}

/** Files on a message: images as thumbnails that open the viewer, other files as chips. */
export function Attachments({
  items,
  align = 'start',
}: {
  items: Attachment[]
  align?: 'start' | 'end'
}) {
  if (!items.length) return null
  return (
    <div className={`attachments ${align}`}>
      {items.map((a) =>
        a.mediaType.startsWith('image/') ? (
          <button
            type="button"
            key={a.path}
            className="attachment-image"
            title={a.name}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('familiar:image', {
                  detail: { src: attachmentUrl(a), alt: a.name, path: a.path },
                }),
              )
            }
          >
            <img src={attachmentUrl(a)} alt={a.name} loading="lazy" />
          </button>
        ) : (
          <button
            type="button"
            key={a.path}
            className="attachment-file"
            title={`用默认应用打开 ${a.name}`}
            onClick={() => api.openAttachment(a.path)}
          >
            <span className="attachment-kind">{fileKind(a.name)}</span>
            <span className="attachment-name">{a.name}</span>
          </button>
        ),
      )}
    </div>
  )
}
