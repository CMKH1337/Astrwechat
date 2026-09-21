import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { AW_ATTACHMENT_LABEL, isLocalAdminUid, type LocalCommandConfig } from '../../../shared/local-commands'
import './LocalCommandSettings.scss'

interface Props {
  config: LocalCommandConfig
  onChange: (patch: Partial<LocalCommandConfig>) => void
}

export default function LocalCommandSettings({ config, onChange }: Props) {
  const [uid, setUid] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const addAdmin = () => {
    const normalized = uid.trim().toUpperCase()
    if (!isLocalAdminUid(normalized)) {
      setError('请填写 #uid 返回的完整 ID：AW- 加 24 位字母数字编号。')
      return
    }
    if (config.local_command_admins.some(admin => admin.uid === normalized)) {
      setError('此管理员已在列表中。')
      return
    }
    if (config.local_command_admins.length >= 100) {
      setError('最多可配置 100 位管理员。')
      return
    }
    onChange({ local_command_admins: [...config.local_command_admins, { uid: normalized, note: note.trim() }] })
    setUid(''); setNote(''); setError('')
  }
  return (
    <div className="slim-card aw-local-settings">
      <div className="slim-card__title">本地指令与管理员</div>
      <p className="aw-local-settings__hint">
        使用另一个微信账号向机器人发送 <code>#uid</code>，将返回的 ID 添加到管理员栏。
        保存后立即生效，无须重启。管理员可使用 #status、#stop、#start 和 #ac；其他用户仅可查看菜单和使用 #uid 查询自己的 ID。
      </p>
      <p className="aw-local-settings__hint">权限绑定真实微信账号，不按昵称判断。群聊黑白名单仍然有效，本地指令和回复不会转发给机器人服务端。</p>
      <div className="aw-local-settings__add">
        <label>管理员 ID
          <input aria-label="管理员 ID" type="text" value={uid} placeholder="AW-…（粘贴完整 ID）" maxLength={40}
            onChange={event => { setUid(event.target.value); setError('') }} />
        </label>
        <label>备注
          <input aria-label="新管理员备注" type="text" value={note} placeholder="例如：我的微信" maxLength={80}
            onChange={event => setNote(event.target.value)} />
        </label>
        <button type="button" className="slim-btn slim-btn--secondary" onClick={addAdmin}><Plus size={14} />添加管理员</button>
      </div>
      {error && <p className="aw-local-settings__error" role="alert">{error}</p>}
      <div className="aw-local-settings__admins">
        {config.local_command_admins.length === 0 && <p className="aw-local-settings__hint">尚未配置管理员：仅开放 #aw 和 #uid，不缓存群聊历史及附件。</p>}
        {config.local_command_admins.map(admin => (
          <div className="aw-local-settings__admin" key={admin.uid}>
            <code>{admin.uid}</code>
            <input type="text" aria-label={`${admin.uid} 的备注`} value={admin.note} maxLength={80} placeholder="备注"
              onChange={event => onChange({ local_command_admins: config.local_command_admins.map(item => item.uid === admin.uid ? { ...item, note: event.target.value } : item) })} />
            <button type="button" className="slim-btn slim-btn--secondary" aria-label={`移除管理员 ${admin.uid}`}
              onClick={() => onChange({ local_command_admins: config.local_command_admins.filter(item => item.uid !== admin.uid) })}><Trash2 size={14} />移除</button>
          </div>
        ))}
      </div>
      <div className="aw-local-settings__code-note">
        附件统一使用“{AW_ATTACHMENT_LABEL}”，例如：<code>[文件] 项目资料.zip ｜ {AW_ATTACHMENT_LABEL}：F7A2B901</code>
      </div>
      <div className="aw-local-settings__limits">
        {([
          ['ac_cache_hours', '附件有效期', '小时', 168],
          ['ac_file_max_mb', '单个附件上限', 'MB', 1024],
          ['ac_cache_max_mb', '附件缓存总上限', 'MB', 4096]
        ] as const).map(([key, label, unit, max]) => (
          <div className="slim-field" key={key}>
            <label htmlFor={`aw-${key}`}>{label}</label>
            <input id={`aw-${key}`} className="bridge-number-input" type="number" min={1} max={max} value={config[key]}
              onChange={event => onChange({ [key]: Math.max(1, Math.min(max, Math.floor(Number(event.target.value) || 1))) })} />
            <span className="slim-field__inline-hint">{unit}</span>
          </div>
        ))}
      </div>
      <p className="aw-local-settings__hint">
        #ac 回显当前群最近 10 条已监听消息，附件仅在缓存成功后显示编号，限原群管理员获取。
        #stop 仅暂停当前会话转发，仍继续缓存；#start 不补发旧消息。已发给服务端的请求及其回复不能撤回。
        历史和编号不跨 Bridge 重启保留；未缓存、未下载或超出上限的附件不能恢复。
      </p>
    </div>
  )
}
