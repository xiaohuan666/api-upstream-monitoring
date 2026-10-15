# 第三方实现来源与适配说明

## OpenAI 已有账号授权入池

参考/移植来源：`zc-zhangchen/any-auto-register`，固定提交
`44c27a8a2ae5e08d37bb68ab007a335782b43467`。

原始仓库：`https://github.com/zc-zhangchen/any-auto-register`

原始文件与本项目适配位置：

| 原始文件 | 保留的逻辑 | 本项目 |
| --- | --- | --- |
| `platforms/chatgpt/rt_backfill.py` | 已有账号邮箱/密码/TOTP/代理输入，取得 refresh_token 才成功 | `tools/oauth_login/flow.py`、`src/oauth-onboarding.mjs` |
| `platforms/chatgpt/protocol/auth_flow.py` | 已有账号登录、密码、MFA/TOTP、授权与人工验证分支 | `tools/oauth_login/flow.py` |
| `platforms/chatgpt/protocol/totp.py` | Base32 TOTP/RFC 6238 验证码生成 | `src/oauth-totp.mjs` |
| `platforms/chatgpt/sub2api_upload.py` | OAuth 凭据、账号标识提取及 group_ids 创建请求 | `src/oauth-sub2-client.mjs` |

固定版本 README 的声明原文：

> MIT License — 仅供学习研究，禁止商业使用。

该提交的文件树未见独立 LICENSE 文件。本说明保留上游的原始声明，
不将其重新解释为不受限制的 MIT 授权。2026-10-06 项目使用者确认本项目用于
非商业监控与推送，并要求按该实现逻辑移植；未来改变使用或分发场景时应重新核对授权。

2026-10-06 HTTP移植替代原先的Playwright页面填写实现：

- `tools/oauth_login/flow.py`：裁剪改写已有账号 warmup/CSRF/signin、密码/MFA、唯一账号会话选择、workspace及OAuth重定向逻辑；不移植注册、猜密码、邮箱/SMS平台或多账号盲选。
- `tools/oauth_login/transport.py`：保留curl_cffi传输和一致会话思想；改为单画像/单代理、每跳白名单、TLS验证、响应体上限，无自动POST重试或普通requests降级。
- `tools/oauth_login/totp.py`：移植RFC6238算法。
- `tools/oauth_login/sentinel.py`、`tools/oauth_login/vendor/`：参考Sentinel支撑逻辑与固定来源JS，具体裁剪与出处见vendor说明；不将上游README的成功宣称当本项目验收证据。
- `src/oauth-login.mjs`：本项目Node/Python秘密stdin与脱敏事件桥接、超时/取消和回调校验。

ChatGPT会话建立与Sub2授权分别核对state；最终授权URL、PKCE session和换码仍由目标Sub2API管理，不使用上游独立生成的Codex verifier。多分组、代理映射、幂等与身份对账继续沿用本项目业务实现。
