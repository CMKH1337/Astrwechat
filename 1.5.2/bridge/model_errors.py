"""Stable, safe Bridge/model error codes; never expose provider exception bodies."""
from dataclasses import dataclass
import asyncio


# code -> (description, local remediation). Both are safe to display in a chat.
ERROR_CATALOG = {
    'E_MODEL_AUTH': ('模型鉴权失败', '请检查 API Key 是否正确、有效，以及是否属于当前服务商'),
    'E_MODEL_PERMISSION': ('模型访问被拒绝', '请检查账号、模型权限及服务商访问限制'),
    'E_MODEL_NOT_FOUND': ('模型或接口不存在', '请检查模型名称、API 基础地址及接口格式'),
    'E_MODEL_QUOTA': ('模型服务要求付费或额度不足', '请检查服务商余额、套餐及额度'),
    'E_MODEL_RATE_LIMIT': ('模型服务限流或配额不足', '请稍后重试，并检查服务商限流与配额'),
    'E_MODEL_TIMEOUT': ('模型请求超时', '请检查网络，或适当增加请求超时后重试'),
    'E_MODEL_NETWORK': ('无法连接模型服务', '请检查网络、代理、DNS、证书和 API 基础地址'),
    'E_MODEL_REQUEST': ('模型服务拒绝请求参数', '请检查接口格式、模型能力、上下文和图片参数'),
    'E_MODEL_CONTEXT': ('当前消息或系统提示词超出模型输入预算', '请缩短内容或按上游能力调整上下文与输出长度'),
    'E_MODEL_TOO_LARGE': ('模型请求内容过大', '请减少上下文或关联图片后重试'),
    'E_MODEL_SERVER': ('模型服务端异常', '请稍后重试，或检查服务商运行状态'),
    'E_MODEL_HTTP': ('模型接口返回异常状态', '请检查 API 基础地址、接口格式及服务商状态'),
    'E_MODEL_RESPONSE': ('模型响应格式异常', '请检查所选接口格式与服务商是否兼容'),
    'E_MODEL_FILTERED': ('模型服务拒绝生成此内容', '请调整提问内容后重试'),
    'E_MODEL_EMPTY': ('模型返回了空回复', '请调整提问，或检查模型与接口格式'),
    'E_MODEL_DEPENDENCY': ('模型依赖缺失或不兼容', '请安装完整版本，并确认 Python 版本与随包依赖匹配'),
    'E_MODEL_CONFIG': ('模型配置无效', '请检查模型名称、API Key、基础地址和超时设置'),
    'E_MODEL_UNKNOWN': ('模型调用失败，原因未识别', '请联系管理员查看 Bridge 日志中的异常类型'),
    'E_MODEL_QUEUE_FULL': ('模型请求队列已满，本次回复已跳过', '请等待已排队请求处理完成后重试'),
    'E_WECHAT_SEND': ('模型已生成回复，但微信发送失败或被中止', '请检查微信窗口、发送权限及独立聊天窗口；不会自动重发'),
    'E_ERROR_NOTIFY_SEND': ('错误码通知发送失败或被中止', '请检查微信窗口及发送权限；不会自动重发'),
    'E_BRIDGE_PROCESS': ('Bridge 处理消息失败', '请联系管理员查看 Bridge 日志中的异常类型'),
}


@dataclass(frozen=True)
class ModelFailure:
    code: str
    http_status: int | None = None

    @property
    def description(self):
        title, hint = ERROR_CATALOG[self.code]
        status = f'（HTTP {self.http_status}）' if self.http_status is not None else ''
        return f'[{self.code}] {title}{status}。{hint}。'

    @property
    def notice(self):
        return f'模型调用失败：{self.description}'


def classify_model_error(error, *, phase='request'):
    """Inspect only exception classes and numeric status; messages may contain credentials."""
    chain, seen, pending = [], set(), [error]
    while pending and len(chain) < 16:
        current = pending.pop(0)
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        chain.append(current)
        pending.append(current.__cause__ or current.__context__)
        children = getattr(current, 'exceptions', ())
        if isinstance(children, (list, tuple)):
            pending.extend(children[:16])
    names = {base.__name__ for item in chain for base in type(item).__mro__}
    status = next((value for item in chain if type(value := getattr(item, 'status_code', None)) is int
                   and 100 <= value <= 599), None)
    if any(isinstance(item, ImportError) for item in chain):
        code = 'E_MODEL_DEPENDENCY'
    elif any(isinstance(item, (TimeoutError, asyncio.TimeoutError)) for item in chain) or names & {
        'APITimeoutError', 'TimeoutException', 'ReadTimeout', 'ConnectTimeout', 'WriteTimeout', 'PoolTimeout'
    } or status in (408, 504):
        code = 'E_MODEL_TIMEOUT'
    elif status is not None:
        code = {400: 'E_MODEL_REQUEST', 401: 'E_MODEL_AUTH', 402: 'E_MODEL_QUOTA',
                403: 'E_MODEL_PERMISSION', 404: 'E_MODEL_NOT_FOUND', 413: 'E_MODEL_TOO_LARGE',
                422: 'E_MODEL_REQUEST', 429: 'E_MODEL_RATE_LIMIT'}.get(
                    status, 'E_MODEL_SERVER' if status >= 500 else 'E_MODEL_HTTP')
    elif names & {'APIConnectionError', 'ConnectError', 'NetworkError', 'ProxyError',
                  'RemoteProtocolError', 'SSLError', 'SSLCertVerificationError', 'gaierror'} or any(
            isinstance(item, ConnectionError) for item in chain):
        code = 'E_MODEL_NETWORK'
    elif 'ContextBudgetError' in names:
        code = 'E_MODEL_CONTEXT'
    elif names & {'ContentFilterError', 'ContentFilterFinishReasonError'}:
        code = 'E_MODEL_FILTERED'
    elif phase == 'startup' and (names & {'UserError', 'ValidationError'} or any(
            isinstance(item, ValueError) for item in chain)):
        code = 'E_MODEL_CONFIG'
    elif names & {'UnexpectedModelBehavior', 'APIResponseValidationError', 'ValidationError',
                  'JSONDecodeError', 'LengthFinishReasonError', 'IncompleteToolCall'}:
        code = 'E_MODEL_RESPONSE'
    else:
        code = 'E_MODEL_UNKNOWN'
    return ModelFailure(code, status)
