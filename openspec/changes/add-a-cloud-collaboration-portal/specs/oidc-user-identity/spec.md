# OIDC User Identity Delta

## MODIFIED Requirements

### Requirement: User Access Token 必须经过严格 RS256、claims 与调用边界验证

A MUST 在解析 User Actor 前验证 JWT Header `alg` 恰为 `RS256`，按非空 `kid` 从受信 JWKS
选择 RSA 公钥并验证签名。A SHALL 验证 `iss` 精确匹配、`aud` 字符串或数组包含
`sciforge-cloud-api`，并验证 `exp`、`iat`、`auth_time` 是具有合法时间语义的 NumericDate，
`sub` 是非空字符串。`nbf` MAY 缺失；缺失时 A SHALL 使用 `iat` 作为本次验证的有效生效
时间，存在时 MUST 将其作为 NumericDate 严格验证。任何一步失败 MUST 在建立 User Actor
之前终止请求。

普通 User 公共 bearer 边界 SHALL 继续只接受 `azp=sciforge-desktop` 或
`azp=sciforge-web-mobile`。仅当固定 Portal confidential-BFF 已启用时，A MAY 另外接受
`azp=sciforge-cloud-console`，但 MUST 只在服务端 Portal session manager 对 Keycloak token
exchange/refresh 得到的 Access Token 建立 BFF User Actor 时接受它。`sciforge-cloud-console`
MUST NOT 成为 Desktop client、Agent identity、service actor 或公共 `/v1/*` 浏览器 bearer
的授权方。浏览器 MUST NOT 接收或提交该 Access Token，且 Portal BFF MUST NOT 接受调用者
提供的 upstream `Authorization` 值。

#### Scenario: 有效 Desktop 或 Web-Mobile Access Token

- **WHEN** Access Token 使用受信 RSA/RS256 key 签名，满足 exact issuer、audience、时间与
  subject 验证，且 `azp` 为 `sciforge-desktop` 或 `sciforge-web-mobile`
- **THEN** A SHALL 在既有普通 User bearer 边界解析一个经过验证的 User 身份输入
- **AND** SHALL 把经过验证的 `auth_time` 放入本次请求的临时认证上下文。

#### Scenario: Portal BFF 验证 confidential client Access Token

- **WHEN** 已启用固定 Portal，服务端使用 `sciforge-cloud-console` secret 完成 code exchange
  或 refresh，并得到满足全部签名、issuer、`aud=sciforge-cloud-api`、时间与 subject 验证、
  且 `azp=sciforge-cloud-console` 的 Access Token
- **THEN** A MAY 仅为当前 server-side Portal session 解析同一个规范 User Actor
- **AND** MUST NOT 把 Access/Refresh/ID Token 或 client secret 返回给浏览器。

#### Scenario: 浏览器直接提交 cloud-console bearer

- **WHEN** `/v1/*`、公共命令边界或 Portal HTTP 请求收到调用者提供的
  `Authorization: Bearer`，且 Token 的 `azp=sciforge-cloud-console`
- **THEN** A MUST 拒绝该 bearer，不得建立 User Actor
- **AND** MUST NOT 将它当成 Desktop、Agent、service client 或 Portal session。

#### Scenario: audience、authorized party 或调用上下文不合法

- **WHEN** `aud` 不包含 `sciforge-cloud-api`，`azp` 不在当前调用上下文的严格 allowlist，
  service client 被送入普通 User 验证，或缺失 `azp`
- **THEN** A MUST 拒绝 User Actor
- **AND** MUST NOT 执行 JIT User 查询或创建。

#### Scenario: 时间、subject、算法或签名不合法

- **WHEN** Token 算法/签名/key 不受信，已过期，存在的 `nbf` 位于未来或类型错误，`iat`
  或 `auth_time` 位于未来或类型错误，必需时间 claim 缺失，或 `sub` 缺失、为空或类型错误
- **THEN** A MUST 拒绝该 Token
- **AND** MUST NOT 执行 JIT User 查询或创建。
