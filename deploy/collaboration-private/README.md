# SciForge Cloud：core-only 预发布与 HTTPS 测试边缘

本目录为 SciForge Cloud ECS 上 `@sciforge/collaboration-server` 的最小 Docker Compose 预发布层。默认仍是 core-only loopback；只有显式叠加 `compose.provider-zulip.yml` 时才启用私有 Zulip Provider。另有互斥、显式的 `a-https-test-edge` 发布模式，仅把 core-only API/WSS 通过 `https://cloud-test.sciforge.cn` 暴露为 A 的测试入口。

`cloud-test` 不是正式产品登录入口：该模式必须保持 OIDC issuer 未配置、Provider catalog 为空、公开控制台返回 404。它只证明受信任 TLS 下的 A core API/WSS 边界，不证明 Keycloak、Zulip、最新版 SciForge 或真实业务身份链路已经接通。

| 层面 | 本目录能证明 | 本目录不能单独证明 |
| --- | --- | --- |
| SciForge Cloud | 固定发布物、数据库、loopback API/WSS、显式 `cloud-test` TLS edge 和重启恢复行为 | 正式登录、Provider 或产品入口已完成 |
| 自动化验收 | HTTP/WSS 公共边界；显式启用时可验证候选 Provider adapter | 真实最新版 SciForge/AgentRuntime 已完成端到端闭环 |
| 产品开放 | loopback 控制台、API 与预发布门禁已经具备 | 正式链路已经选定，或成员业务验收已经完成 |

## 重要边界

- 运行镜像只安装固定 commit 生成的三个 npm tarball：contracts、Zulip provider 和 server。默认发布仍只接受已进入 `origin/gui` 历史的获批 commit；未合并 feature commit 只能使用下述显式 `private-test`、`team-private-acceptance` 或互斥的 `a-https-test-edge` 模式。Docker build context 受 `.dockerignore` 限制，不复制或编译 SciForge 源码。
- 默认是 **core-only**：`compose.yml` 不注入 Provider 配置或 secret。`deploy-provider-zulip.sh` 才会显式加载只作用于 app 的 overlay；migrate 始终看不到 Provider 配置和 secret。
- `compose.yml` 支持透传严格 OIDC 的非秘密配置，但当前正式 issuer 尚未选定。`SCIFORGE_COLLABORATION_OIDC_ISSUER` 为空时进程和数据库 readiness 正常，所有 User、Device 与 binding 入口必须 fail closed；这不是匿名身份模式，也不得恢复 opaque User bearer。Audience 固定为 `sciforge-cloud-api`，授权方固定为 `sciforge-desktop,sciforge-web-mobile`，生产不得允许非 HTTPS issuer。
- 原生入口是 `POST /v1/commands`、WebSocket `/v1/events` 和 A-only 网页控制台 `/console/`；没有 `/v1/meta`，也没有旧实验服务的 `/v1/ws`。
- 应用在容器内监听 `0.0.0.0:8787`，但 Docker 只向 ECS `127.0.0.1:${SCIFORGE_COLLAB_HOST_PORT}` 发布。PostgreSQL 不发布宿主机端口。
- 默认与 Provider 私有模式不开放 80/443。只有 `a-https-test-edge` 使用固定 digest 的独立 Caddy Compose 项目发布 TCP 443→容器 8443；不开放 80、UDP 443、8080、8787 或 PostgreSQL，不代理 `login-test.sciforge.cn`，也不加入数据库网络。
- 本目录只定义 A 的 HTTP/WSS 公共协作边界，不决定最新版 SciForge 最终从何处接入，也不决定 Zulip 是否成为正式 Human Provider。可选 Zulip adapter 只代表一个显式启用的服务器验收候选，不得外推为产品唯一链路。
- app 与一次性 migrate 容器固定使用非登录 UID/GID `10001:10001`；Provider secret 由宿主机 `root:10001`、文件 `0640`、目录 `0750` 提供，other 无任何权限。Provider 部署门禁还会拒绝 `sciforge-admin` 或任一可登录宿主机账号把数值 GID `10001` 作为主组或附加组；宿主机没有对应的 NSS group 条目是允许的，容器仍可按数值 GID 读取只读挂载。

## 1. 在可信构建机生成 release bundle

先确认工作树干净且 commit 是获批的 `origin/gui` commit，再测试并调用仓库内的 bundle builder。以下 `release_commit` 必须是完整 40 位 SHA：

```bash
git fetch origin refs/heads/gui:refs/remotes/origin/gui
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
test "$release_commit" = "$(git rev-parse origin/gui)"

npm ci
artifact_dir="$(mktemp -d)"
npm run collaboration:a:typecheck
npm run collaboration:a:test
npm run collaboration:bundle -- \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

`collaboration:a:*` 是本目录发布的 A-only 门禁，只覆盖公共 contracts、Provider adapter 边界、Collaboration Server/PostgreSQL 与 A 的服务器 conformance。根级 `collaboration:typecheck`/`collaboration:test` 还包含本地 domain、projection 与跨团队客户端适配；A 不得为了让它们通过而修改 C Runtime、D 消息解析或 E UI。公共合同发生破坏性升级时，这些跨团队适配应作为明确 handoff 单独完成，不能被误算为 A 云端发布代码。

默认模式不会接受仅存在于 feature branch 的 HEAD，manifest 会记录 `releaseMode: "origin-gui"`，且原有 `git merge-base --is-ancestor <HEAD> origin/gui` 生产检查不会被放宽。

### 仅 A 私有 ECS 的 feature 测试发布

如果必须在合并前验证当前 feature commit，只能显式传入 `--private-test-release`。构建前先更新远端基线、提交全部预期变更并保证工作树 clean；builder 会再次要求 `--commit` 等于完整 HEAD SHA，并验证当前完整 `origin/gui` commit 是 HEAD 的 ancestor：

```bash
git fetch origin refs/heads/gui:refs/remotes/origin/gui
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
base_commit="$(git rev-parse origin/gui)"
git merge-base --is-ancestor "$base_commit" "$release_commit"

npm ci
artifact_dir="$(mktemp -d)"
npm run collaboration:a:typecheck
npm run collaboration:a:test
npm run collaboration:bundle -- \
  --private-test-release \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

该模式不会成为默认值。manifest 必须同时记录 `releaseMode: "private-test"`、feature `contractCommit` 和完整 `baseCommit`；构建日志会明确显示 `TEST-ONLY PRIVATE RELEASE`。这种 artifact 只允许部署到本 A 专用 ECS 的现有 loopback-only Compose，通过 SSH tunnel 验证；不得开放公网、接入域名/TLS/反向代理、推送为共享生产 artifact、交给 B–E 联调或冒充 `origin-gui` 正式发布。feature 合并后必须重新用默认模式构建正式 bundle，不能给 private-test artifact 改名继续使用。

### 团队私有验收 bundle

需要让团队通过同一台 A ECS 做合并前验收时，必须使用名称明确、不可隐式启用的 `--team-private-acceptance` 模式。它与 `--private-test-release` 互斥，仍要求工作树 clean、`--commit` 等于完整 HEAD，并验证完整 `origin/gui` 是 HEAD 的 ancestor：

```bash
git fetch origin refs/heads/gui:refs/remotes/origin/gui
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
base_commit="$(git rev-parse origin/gui)"
git merge-base --is-ancestor "$base_commit" "$release_commit"

artifact_dir="$(mktemp -d)"
npm run collaboration:bundle -- \
  --team-private-acceptance \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

manifest 会记录 `releaseMode: "team-private-acceptance"`、完整 `baseCommit`、完整 `contractCommit` 和 `deploymentBoundary: "loopback-ssh-tunnel-only"`。这不会放宽默认 `origin-gui` 发布规则；artifact 不得绑定公网地址、反向代理或域名，也不得当作正式发布。

### A 的 HTTPS core-only 测试边缘 bundle

`cloud-test.sciforge.cn` 只能使用互斥的显式模式构建：

```bash
git fetch origin refs/heads/gui:refs/remotes/origin/gui
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
base_commit="$(git rev-parse origin/gui)"
git merge-base --is-ancestor "$base_commit" "$release_commit"

npm ci
artifact_dir="$(mktemp -d)"
npm run collaboration:a:typecheck
npm run collaboration:a:test
npm run collaboration:bundle:test
bash deploy/collaboration-private/scripts/static-policy-test.sh
npm run collaboration:bundle -- \
  --a-https-test-edge \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

manifest 必须记录 `releaseMode: "a-https-test-edge"`、`deploymentBoundary: "public-https-core-only"` 和唯一 `hostname: "cloud-test.sciforge.cn"`。该模式不允许 Provider overlay，必须保持 OIDC issuer 为空，只允许浏览器 Origin `https://cloud-test.sciforge.cn`。它不是 Keycloak、Zulip、Desktop 登录或真实业务 E2E 的完成证明。

将 `artifact_dir/release/` 的完整 bundle 复制到本目录的 `bundle/`：三个 `.tgz`、`package.json`、`package-lock.json`、`CONTRACT_COMMIT`、`RELEASE_MANIFEST.json` 和 `SHA256SUMS`，共八个文件。除 `SHA256SUMS` 自身外的七项发布输入都必须由它覆盖；部署还会检查 manifest 的 commit、artifact 类型和三个包文件名。bundle 只能包含这些文件以及部署目录自带的 `.gitignore`，任何额外文件、目录或 symlink 都会被拒绝。`bundle/.gitignore` 会阻止发布产物被提交到 Git。

在可信构建机上从 exact commit 归档部署树，并把刚生成、已验证的八个 bundle 文件装入归档；不要从随后可能变化的工作树直接打包：

```bash
set -euo pipefail
package_root="$(mktemp -d)"
archive="$artifact_dir/sciforge-collaboration-private-$release_commit.tar.gz"
sidecar="$archive.sha256"
trap 'rm -rf -- "$package_root"' EXIT

test "$release_commit" = "$(git rev-parse --verify HEAD^{commit})"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git archive --format=tar "$release_commit" deploy/collaboration-private \
  | tar -xf - -C "$package_root"
bundle_source="$artifact_dir/release"
bundle_target="$package_root/deploy/collaboration-private/bundle"
test "$(find "$bundle_source" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" = 8
test -z "$(find "$bundle_source" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
cp -- "$bundle_source"/* "$bundle_target/"
(cd "$bundle_target" && shasum -a 256 -c SHA256SUMS)
test -z "$(find "$package_root" -type l -print -quit)"
tar -C "$package_root" -czf "$archive" deploy
archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
printf '%s  %s\n' "$archive_sha" "$(basename "$archive")" > "$sidecar"
printf 'trusted_archive_sha=%s\narchive=%s\nsidecar=%s\n' \
  "$archive_sha" "$archive" "$sidecar"
```

最后一行的 `trusted_archive_sha` 必须由 A 从可信构建机另行记录，并在 ECS root 安装步骤中显式填写；不能只信任与归档放在同一上传落点的 sidecar。

SHA-256 全部通过后，部署脚本直接读取已校验 server tarball 内的 `package/migrations/NNNN_<name>.sql`，要求 migration 从 `0001` 连续、每项为非空 regular file，并以严格格式解析全部 `CREATE TABLE [IF NOT EXISTS] sciforge_collaboration.<name>`。最高 migration 编号和完整排序表集由 release 自动推导；验收不读取源码目录，也不接受 env 自报 schema version/table list。新增 migration 必须保持连续文件名，无法安全解析的 `CREATE TABLE` 或空表集合会在操作数据库前失败。

服务器不需要也不应 clone SciForge 仓库。向 ECS 传输由固定 commit 归档出的本部署目录和上述 bundle；不要传输 `node_modules`、源码、`.git` 或开发 `.env`。必须先在 root-only staging 中校验归档路径、bundle SHA 和 commit，再把整棵 release 设为 `root:root`、目录及文件均禁止 group/other 写入，并原子重命名到 `/srv/sciforge-collaboration/releases/<commit>/`。所有部署命令只能从该固定目录运行；不得直接从登录用户拥有或可替换父目录的 `scp` 落点执行。

ECS 上的最小原子安装形态如下；先把归档及其传输前生成的摘要放到普通上传落点，再由 root 复制成 root-only、不可由部署账号替换的 regular file，之后才允许校验和解包：

```bash
set -euo pipefail
release_commit=<完整40位commit>
upload_archive=<登录账号上传的归档绝对路径>
upload_checksum=<登录账号上传的.sha256绝对路径>
trusted_archive_sha=<从可信构建机独立记录的64位SHA-256>
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$upload_archive" = /* && "$upload_checksum" = /* ]]
[[ "$trusted_archive_sha" =~ ^[0-9a-f]{64}$ ]]
incoming="/srv/sciforge-collaboration/incoming/$release_commit"
archive="$incoming/sciforge-collaboration-private-$release_commit.tar.gz"
checksum="$archive.sha256"
stage="/srv/sciforge-collaboration/releases/.$release_commit.staging"
final="/srv/sciforge-collaboration/releases/$release_commit"

test "$(id -u)" = 0
test -f "$upload_archive" && test ! -L "$upload_archive"
test -f "$upload_checksum" && test ! -L "$upload_checksum"
test -d /srv && test ! -L /srv
test "$(stat -c '%u:%g' /srv)" = 0:0
srv_permissions="$(stat -c '%a' /srv)"
test "$((8#$srv_permissions & 022))" -eq 0
for directory in /srv/sciforge-collaboration \
  /srv/sciforge-collaboration/incoming \
  /srv/sciforge-collaboration/releases; do
  test ! -L "$directory"
  install -d -o root -g root -m 0755 "$directory"
  test "$(readlink -f "$directory")" = "$directory"
  test "$(stat -c '%u:%g' "$directory")" = 0:0
  permissions="$(stat -c '%a' "$directory")"
  test "$((8#$permissions & 022))" -eq 0
done
test ! -e "$incoming" && test ! -e "$stage" && test ! -e "$final"
install -d -o root -g root -m 0700 "$incoming"
test "$(readlink -f "$incoming")" = "$incoming"
test "$(stat -c '%u:%g:%a' "$incoming")" = 0:0:700
install -o root -g root -m 0600 -- "$upload_archive" "$archive"
install -o root -g root -m 0600 -- "$upload_checksum" "$checksum"
test "$(stat -c '%u:%g:%a' "$archive")" = 0:0:600
test "$(stat -c '%u:%g:%a' "$checksum")" = 0:0:600
test -f "$archive" && test ! -L "$archive"
test -f "$checksum" && test ! -L "$checksum"
mapfile -t checksum_lines < "$checksum"
test "${#checksum_lines[@]}" -eq 1
checksum_line="${checksum_lines[0]%$'\r'}"
archive_name="$(basename "$archive")"
[[ "$checksum_line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]]
test "${BASH_REMATCH[2]}" = "$archive_name"
test "${BASH_REMATCH[1]}" = "$trusted_archive_sha"
test "$(sha256sum "$archive" | awk '{print $1}')" = "$trusted_archive_sha"
tar -tzf "$archive" | awk '
  /(^|\/)\.\.(\/|$)/ || /^\// { bad=1 }
  $0 != "deploy/" && $0 != "deploy/collaboration-private/" && index($0,"deploy/collaboration-private/") != 1 { bad=1 }
  END { exit bad }
'
tar -tvzf "$archive" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { bad=1 } END { exit bad }'
install -d -o root -g root -m 0755 "$stage"
tar --extract --gzip --no-same-owner --file "$archive" --directory "$stage"
test -z "$(find "$stage" -type l -print -quit)"
test "$(tr -d '\r\n' < "$stage/deploy/collaboration-private/bundle/CONTRACT_COMMIT")" = "$release_commit"
chown -R root:root "$stage"
find "$stage" -perm /6000 -exec chmod a-s {} +
find "$stage" -type d -exec chmod go-w {} +
find "$stage" -type f -exec chmod go-w {} +
mv -- "$stage" "$final"
```

## 2. 创建服务器环境文件

生产 env 固定放在 release 目录之外，避免切换或清理 release 时误删 secret：

```bash
sudo install -d -o root -g root -m 0700 /srv/sciforge-collaboration/secrets
sudo install -o root -g root -m 0600 /dev/null \
  /srv/sciforge-collaboration/secrets/collaboration.env
sudoedit /srv/sciforge-collaboration/secrets/collaboration.env
```

参考 `.env.example` 填写全部变量。分别运行两次 `openssl rand -hex 32`，为 `sciforge_admin` 初始化管理员和 `sciforge_collab` 应用角色生成不同密码。应用角色是数据库 owner，但显式为 `NOSUPERUSER NOCREATEDB NOCREATEROLE`；app/migrate 容器只获得应用密码，管理员密码只进入 PostgreSQL 容器。不要把密码放进命令参数、聊天、Git、日志或截图。初始化数据库后不要只修改 env 来“轮换”密码；PostgreSQL 角色和连接串必须在维护窗口内同步变更。

脚本只接受 regular、非 symlink、无 group/other 权限的 env 文件，并用受限 literal parser 读取必要字段；不会 `source` env 文件，也不会打印 secret。

使用 HTTPS test edge 时，env 还必须精确设置：

```dotenv
SCIFORGE_COLLABORATION_ALLOWED_ORIGINS=https://cloud-test.sciforge.cn
SCIFORGE_A_HTTPS_TEST_EDGE_IPV4=47.76.230.118
SCIFORGE_A_HTTPS_TEST_EDGE_STATE_DIR=/srv/sciforge-collaboration/a-https-test-edge
SCIFORGE_COLLABORATION_OIDC_ISSUER=
SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK=false
```

ACME 账户与证书私钥保存在 release 目录外的固定 state 目录。部署脚本将根目录设为 `root:root/0750`，将 `data/` 和 `config/` 设为 `10002:10002/0700`；另建 `approval/` 为 `root:10002/0750` 并只读挂入容器，批准 marker 为 `root:10002/0440`，未验证的 Caddy 无权自行批准。回滚只停止 edge，绝不删除该目录。

首次启动必须使用新的 `collaboration-db` named volume：官方 PostgreSQL entrypoint 只会在空数据目录执行 `postgres-init/`，从而创建独立管理员和最小权限应用角色。如果检测到旧 volume 缺少 `sciforge_admin` 或应用角色仍有超级用户权限，健康检查/验收会失败；先保全备份并做显式迁移，不得通过删除唯一 volume 绕过检查。

### 可选 Zulip Provider 文件

core-only 不需要下列文件。启用 Zulip 前，在宿主机为容器的数值 GID `10001` 准备只读 config 和 secret；如果该 GID 已属于其他用途，先停止，不要复用：

```bash
getent group 10001
sudo install -d -o root -g 10001 -m 0750 \
  /srv/sciforge-collaboration/provider \
  /srv/sciforge-collaboration/provider/secrets
sudo install -o root -g 10001 -m 0640 \
  deploy/collaboration-private/provider-config.example.json \
  /srv/sciforge-collaboration/provider/providers.json
sudo install -o root -g 10001 -m 0640 /dev/null \
  /srv/sciforge-collaboration/provider/secrets/zulip-api-key
sudoedit /srv/sciforge-collaboration/provider/providers.json
sudoedit /srv/sciforge-collaboration/provider/secrets/zulip-api-key
```

`providers.json` 只放 `realmUrl`、Bot email、secret 文件名和 assurance，不放 API key。实际 env 继续为 `0600`，并填写示例中的 `SCIFORGE_COLLAB_PROVIDER_CONFIG_FILE` 与 `SCIFORGE_COLLAB_PROVIDER_SECRET_DIR`。脚本只接受固定 `/srv/sciforge-collaboration/provider` 路径、`root:10001`、config/secret 文件 `0640`、secret 目录 `0750`、无 symlink 且单个 secret 不超过 64 KiB。

## 3. 部署

```bash
release_dir="/srv/sciforge-collaboration/releases/<完整40位contract-commit>"
sudo "$release_dir/deploy/collaboration-private/scripts/deploy.sh" \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

部署脚本执行以下固定顺序：

1. 验证 bundle 精确文件集合、commit、tarball 结构、全部 SHA-256，并从 server tarball 推导 migration/table truth；
2. 生成带固定 `org.opencontainers.image.revision` 的 runtime image；
3. 在任何可能重建或启动 PostgreSQL 的操作前先停止旧 app；
4. 启动并等待 PostgreSQL healthy，创建发布前 custom-format 备份；
5. 使用同一 runtime image 显式执行一次 `migrate`；
6. 启动 app 并等待 `/readyz`；
7. 执行 loopback、与 release migration 完全一致的 schema version/table set、image revision、core-only provider 拒绝和认证边界验证。

core-only、Zulip Provider 与 HTTPS edge 入口共享 root-only `/run/sciforge-collaboration-private/deploy.lock` 的非阻塞独占锁，拒绝发布并发执行；脚本会先验证 `/run`，再创建 `root:root/0700` 专用目录，绝不在共享 sticky 目录中跟随预置 lock symlink。迁移失败时 app 保持停止，不能跳过迁移强行启动。如果 app 启动或 core-only 门禁验证失败，部署 trap 只有在当前 app container ID 仍等于本次记录的候选 ID、且候选与当前 revision 都等于获批 commit 时，才按该不可复用的显式 container ID 停止它；不会在身份检查后再按 Compose service 名称选取容器。若人工恢复或其他操作已经替换 app，trap 只报警并拒绝误停。PostgreSQL、named volume、失败容器日志、备份与 release 现场都会保留，数据库 volume 不随 app image 更新而删除，也不会自动声称回滚成功。

### 显式启用 Zulip Provider

```bash
release_dir="/srv/sciforge-collaboration/releases/<完整40位contract-commit>"
sudo "$release_dir/deploy/collaboration-private/scripts/deploy-provider-zulip.sh" \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

这个入口额外加载 `compose.provider-zulip.yml`。overlay 只修改 app，并以只读 bind mount 注入 config 和 secret；migrate 不获得这两个环境变量或 mount。启动时 runtime 会调用 `diagnose()` 并将统一脱敏后的结果写入 `provider_diagnostics`。Provider 状态不改变 `/readyz` 的数据库就绪语义，但 `verify-provider-zulip.sh` 会作为单独发布门禁，要求 catalog 恰好只有 `zulip`，且数据库中存在晚于本次 app 容器启动、十分钟内的 `healthy` 诊断。验证过程不打印 secret、配置正文或诊断私有细节。若 app 启动或门禁验证失败，部署 trap 会停止本次未获验证的 app，并保留 PostgreSQL、named volume、失败容器日志、备份与 release 现场供诊断；它不会删除数据、自动声称回滚成功或继续对团队开放失败版本。

### 显式启用 `cloud-test` HTTPS/WSS core-only edge

上线前置必须同时成立：公共 DNS 的 A 记录唯一为 `47.76.230.118` 且无 AAAA；若设置 CAA 必须允许 Let’s Encrypt；阿里云安全组和宿主防火墙入站只新增 TCP 443，不能开放 80、UDP 443、8080、8787 或 5432，原有 22 规则不变；ECS/容器出站必须允许 DNS、TCP 443 访问 ACME，以及拉取固定 Caddy digest 所需的 Docker registry/auth/CDN（也可事先安全预载同一 digest）。443 不能被其他宿主进程或容器占用；本流程不修改 `login-test` DNS、Keycloak 或其数据库。TLS-ALPN-01 的验证来源地址不固定，因此不能把 443 只限制到团队 `/32`；如需此限制，必须另行采用最小权限 DNS-01，不能让本脚本假通过。

若已有 edge，更新 app 或切换 Provider 前必须先从旧 fixed release 显式移除它；这会造成预期的短暂 443 停机，但保留证书状态、app、PostgreSQL 和网络：

```bash
current_edge_release="/srv/sciforge-collaboration/releases/<当前edge的完整40位commit>"
sudo "$current_edge_release/deploy/collaboration-private/scripts/disable-a-https-test-edge.sh"
```

`deploy.sh` 和 `deploy-provider-zulip.sh` 都会在任何 app/数据库变更前拒绝仍存在的 edge、任何宿主或 Docker 443 暴露，以及被其他容器污染的 `private-edge` 网络。不得绕过这一步让动态 `app` DNS 提前指向未验证的新候选。

随后使用新 `a-https-test-edge` bundle 运行 PostgreSQL v5 隔离门禁和 `deploy.sh`，确保 app 已以新 fixed commit、精确 Origin、空 OIDC issuer 和空 Provider catalog 运行；最后执行：

```bash
release_dir="/srv/sciforge-collaboration/releases/<获批的完整40位contract-commit>"
sudo "$release_dir/deploy/collaboration-private/scripts/deploy-a-https-test-edge.sh" \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

脚本只启动独立 `sciforge-collaboration-a-https-test-edge` Compose 项目。Caddy 固定为 `2.11.4-alpine` 的完整 linux/amd64 digest；启动器把镜像内带低端口 file capability 的固定二进制复制到 64 MiB、`nosuid/nodev` 的容器临时可执行目录以去掉该 capability，再以 `10002:10002`、只读 rootfs、空 capability set 和 `no-new-privileges` 运行。它只加入现有 `private-edge` 网络，不加入 database network，不挂 Docker socket。公网只发布 TCP 443 到容器 8443，ACME 禁用 HTTP challenge 并仅使用 TLS-ALPN-01，因此 80 和 UDP 443 必须保持关闭。

ECS 本地验证要求受信任证书链和 SAN、`healthz/readyz=200`、catalog 为空、无认证 WSS 为 401、错误 Origin 为 403、`/console/` 为 404，并证明 app container ID、image、PID、RestartCount 和启动时间均未变化。这里的 WSS 只证明 Upgrade 请求经过 Caddy 后仍按认证与 Origin 边界 fail closed，不证明带真实凭据的 `101`、帧透传或 Inbox replay。`login-test.sciforge.cn` 不由该 edge 终止 TLS。失败 trap 只按本次候选 container ID 停止未验证 edge，保留 ACME state，且不改 app、PostgreSQL 或 SSH Tunnel。

可随时独立复验：

```bash
release_dir="/srv/sciforge-collaboration/releases/<获批的完整40位contract-commit>"
sudo "$release_dir/deploy/collaboration-private/scripts/verify-a-https-test-edge.sh" \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

本地门禁通过后，还必须在 ECS 之外的独立公网网络、从同一 fixed release 运行无代理公网探针；只有它通过才能宣告 `cloud-test` 公网可达：

```bash
release_commit=<获批的完整40位contract-commit>
fixed_release_copy=<本机已核验的fixed-release目录>
manifest="$fixed_release_copy/deploy/collaboration-private/bundle/RELEASE_MANIFEST.json"
external_verifier="$fixed_release_copy/deploy/collaboration-private/scripts/verify-a-https-test-edge-external.sh"
external_sha="$(node -e '
  const m = require(process.argv[1])
  const commit = process.argv[2]
  if (m.contractCommit !== commit
      || m.releaseMode !== "a-https-test-edge"
      || m.deploymentBoundary !== "public-https-core-only"
      || m.hostname !== "cloud-test.sciforge.cn"
      || !/^[0-9a-f]{64}$/.test(m.edgeExternalVerifyScriptSha256 ?? "")) process.exit(1)
  process.stdout.write(m.edgeExternalVerifyScriptSha256)
' "$manifest" "$release_commit")"
"$external_verifier" "$release_commit" "$external_sha"
```

该探针通过公共 DNS 精确校验 A/AAAA，直连 `47.76.230.118:443` 验证受信任 TLS、不可缓存的 exact commit 响应头、HTTP 与 WSS 拒绝边界，并从该独立观察点补充验证 80、8080、8787、5432 不可达；ECS 本地门禁同时以宿主 listener 和 Docker PortBindings 证明这些后端端口没有公网绑定，因此不会只依赖外部网络自身的出口策略。它不会声称 OIDC、Provider、成功认证 WSS 或业务 E2E 已完成。首次启动失败后，从该候选所属的 fixed release 运行零参数 `disable-a-https-test-edge.sh` 删除停止的精确候选，再重试。

回滚顺序固定为：先关闭安全组 443；从当前 edge 的可信 fixed release 运行 `disable-a-https-test-edge.sh`；保留 ACME state；若还需回退 app，仅在 schema 兼容已确认后，从目标旧 fixed release 重新运行它自己的 v5 attestation 与 `deploy.sh`。只有当目标旧 release 本身也是 `a-https-test-edge` 且重新通过本地和外部门禁时才可重开 443；旧的 loopback-only release 只能保持 443 关闭。绝不删除 collaboration volume、database network 或固定 ACME state。

### 旧两用户 Zulip harness 的状态

仓库仍保留历史 `scripts/collaboration-a-two-user-e2e.test.mjs`，但它建立在旧匿名 pairing、opaque User credential 与固定 Zulip 流拓扑上，不属于统一 OIDC User → Device → Agent 合同的 A 发布门禁，本轮不得运行或据此宣告业务 E2E。A 不会为了兼容该 harness 恢复匿名入口，也不会要求普通成员提交个人 Zulip API key。

正式身份来源、D→A trusted binding confirm、Human Provider 与最新版 SciForge 接入方式冻结后，应由对应成员基于公开机器合同提供新的跨团队 E2E；A 只负责让云端 API、事务、审计、Inbox 与 fail-closed 边界可验证。在那之前，`collaboration:a:test`、真实 PostgreSQL v5 隔离测试和本目录的 core-only 云端门禁是 A 的权威验收，不能冒充真实 Keycloak、Desktop 或 Zulip 往返闭环。

## 4. 通过 SSH Tunnel 使用

开发机建立隧道：

```bash
ssh -N -L 18080:127.0.0.1:8787 \
  -i <SSH_KEY_PATH> \
  sciforge-admin@<A_ECS_IP>
```

然后只在开发机访问：

```text
http://127.0.0.1:18080/healthz
http://127.0.0.1:18080/readyz
http://127.0.0.1:18080/v1/commands
ws://127.0.0.1:18080/v1/events
```

如确有低层协议或故障诊断需要，团队预发布验收不得共享管理员账号或一把 key。B、C、D、E 可各使用独立的 `sciforge-tunnel-b` 至 `sciforge-tunnel-e`；SSH tunnel 不是正常产品访问方式，也不能替代后续获批的正式入口、身份或 Provider 方案。安装时必须提供成员字母、该成员独立的 ed25519 公钥和其真实公网出口 `/32`；key 默认 14 天到期，也可提供更早的 OpenSSH `YYYYMMDDHHMMSSZ` 时间：

```bash
sudo deploy/collaboration-private/scripts/install-tunnel-user.sh \
  b /root/member-b.pub <MEMBER_B_PUBLIC_IPV4>/32 \
  --confirm-tunnel-account-change
```

脚本同时写入并用 `sshd -t`/`sshd -T` 验证独立 `Match User`：只允许 TCP local forwarding 到 `127.0.0.1:8787`，显式设置 `AllowStreamLocalForwarding no`，拒绝 Unix-domain socket forwarding、remote forwarding、shell、PTY、SFTP/SCP、agent、X11 和 user-rc；authorized key 还包含 `from=<公网/32>`、`expiry-time`、`restrict` 和同一 `permitopen`。阿里云安全组的 22 端口仍应只允许这些已确认的 `/32`，脚本不会修改安全组。

成员使用自己的账号：

```bash
ssh -N -L 18080:127.0.0.1:8787 \
  -i <MEMBER_B_PRIVATE_KEY> \
  sciforge-tunnel-b@<A_ECS_IP>
```

独立撤销 B 不会影响 C/D/E，并会终止 B 已建立的 tunnel：

```bash
sudo deploy/collaboration-private/scripts/revoke-tunnel-user.sh \
  b --confirm-tunnel-account-change
```

`verify.sh` 会执行一次真实但受限的 core-only API smoke：provider catalog 必须为空；无 OIDC bearer 的 `pairing.begin`、JWT 形态但不可验证的 `/v1/me`、以及未配置 trusted confirm adapter 的 Zulip binding confirm 都必须返回 401，不得返回一次性材料，也不得新增 User、Device enrollment 或 binding request；随后确认未认证 `user.get` 和 WebSocket Upgrade 同样返回 401。该 smoke 不创建 User，不能被描述为身份登录、用户绑定或 Project/Task 闭环。

可单独复核：

```bash
sudo deploy/collaboration-private/scripts/verify.sh \
  <同一完整contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

## 5. 备份与恢复门槛

```bash
sudo deploy/collaboration-private/scripts/backup.sh \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

备份路径只允许 `/srv/sciforge-collaboration/backups`，防止误配置后对 `/etc` 等路径执行 `chmod` 或过期清理。首次使用新脚本前，部署清单必须先确认该精确目录已经修正为 `root:root/0700`；脚本本身也会用 `install -d -o root -g root -m 0700` 幂等修正并以 `stat` 验证，避免部署用户删除或替换 root-owned dump/sidecar。备份脚本使用 `flock` 防止并发，调用 PostgreSQL 17 容器内的 `pg_dump` 生成 custom format，设置 `--no-owner --no-privileges`，先写临时文件、校验 `pg_restore --list`，再原子改名并创建相对文件名 SHA-256 sidecar。备份文件为 `0600`，保留 14 天。

每次发布和定期演练时，用管理员身份在同一个 PostgreSQL 实例内创建严格随机命名的隔离临时数据库，验证 sidecar、恢复、release-derived schema version/完整表集合及每张 release 表与源库的 row count；脚本的 `trap` 只删除该临时数据库，不覆盖主业务库。row count 对比要求使用刚生成的备份，并在无业务写入的维护窗口立即运行：

```bash
sudo deploy/collaboration-private/scripts/verify-backup-restore.sh \
  /srv/sciforge-collaboration/backups/collaboration-<UTC时间>.dump \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

本地备份只是第一层。每份 dump 和 sidecar 还应复制到加密的异机存储。灾难恢复仍应使用新的 volume；不得直接覆盖唯一生产 volume。

### PostgreSQL v5 隔离业务语义验收

固定 v5 bundle 传到 release 目录后、运行 `deploy.sh` 迁移生产库之前，在无业务写入的维护窗口先运行一次真实 PostgreSQL 隔离验收：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-v5-integration.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-isolated-database-test
```

脚本与 core/provider 部署共享同一个非阻塞 deploy lock，并在锁内先执行候选 release 的 `docker compose build app`；这一步只构建带固定 revision 的候选 image，不停止或替换当前 app、不启动或重启 PostgreSQL，也不迁移生产库。当前 live app 可以仍是上一固定 commit，脚本会记录它的 container ID、host PID、RestartCount、image 和 revision，并要求前后完全不变。它还要求 PostgreSQL 只连接 `internal=true` 的专用 Compose network 且没有宿主机端口，然后用候选 runtime image 中已经安装的生产 `dist`、migration 和依赖启动一次性非 root runner；不会向 ECS 复制源码、test fixture、Vitest、tsx 或开发依赖。隔离验收通过后再运行 `deploy.sh`；后者会复用候选 image build cache、备份并迁移生产库。

管理员密码不会进入 Docker Config、命令参数、URL 环境变量或日志。宿主机只在 `/run` tmpfs 创建一个 `root:10001/0440` 的 64 位十六进制单值文件，并只读挂载给 runner；runner 在内存中构造固定指向 `postgres:5432/postgres` 的管理员 URL。它创建名称严格匹配 `sciforge_identity_v5_it_<pid>_<12位hex>` 的随机临时数据库，在其中验证 v1→v5 readiness、旧 Agent 撤销、并发 OIDC JIT、Device→Agent 生命周期和 Zulip binding 唯一性，随后在 `finally` 中终止连接并删除该库。外层 trap 只在运行前确认没有同前缀遗留库后，才会按同一严格正则清理本次异常退出的残留；绝不把 `sciforge_collaboration` 作为删除目标。

验收会以生产库当时的实际 migration versions 和实际表集为准（允许它仍是 v3/v4）。前后快照各自在独立的、受限的候选镜像容器内运行，不向 live app 容器注入代码或占用其 cgroup；容器只读挂载单值 `sciforge_collab` 密码文件，不把数据库 URL 或密码放进 Docker env/argv。每次快照使用单个 `REPEATABLE READ READ ONLY` 事务，对每张实际表声明 server-side cursor，并以 `FETCH FORWARD 512` 有界流式计算 row count 和稳定内容 SHA-256；只保留表名、计数及摘要，不输出行内容，并要求运行前后整个快照完全相同。为避免并发业务写入造成误报或掩盖边界，本步骤必须处于无业务写入的维护窗口。live app 的 container ID、host PID、RestartCount、image 和 revision 也必须完全相同。runner 原始日志先保存在 root-only tmpfs 文件中，并同时扫描实际管理员密码、应用数据库密码、认证 URL、连接参数、stack 和 `secretKey`；只有通过扫描后才输出脱敏 pass receipt。注意：`CREATE/DROP DATABASE` 必然写 PostgreSQL 集群 catalog/WAL，但所有业务 fixture 只写随机临时数据库，不写生产 `sciforge_collaboration`。

完整验收及其清理成功后，脚本以原子改名写入 `/run/sciforge-collaboration-private-postgres-v5.attestation`：文件固定为 `root:root/0600`，绑定获批 commit、候选 image ID、release manifest、bundle checksums、contract commit 文件以及 runner/verifier 脚本摘要，并记录 UTC 时间。证明最多有效 30 分钟且只能使用一次；core-only 的 `deploy.sh` 和 Provider 的 `deploy-provider-zulip.sh` 都会在停止 app、启动 PostgreSQL、备份或迁移之前，通过共享 helper 原子 claim 该文件，重新核对所有绑定值后立即消费。候选 image 重建结果、bundle 或验收脚本发生任何变化，或者证明缺失、失败、过期、来自未来，部署都会拒绝继续。每次重新运行验收都会先安全删除旧证明；若 runner、临时库、tmpfs secret/log 或容器清理失败，刚生成的证明也会被删除，因此失败的验收不能沿用之前的 pass。任何测试失败、残留库、清理失败、生产内容快照变化或 app 身份变化都会阻断部署；这项测试也不能替代正式 Provider、OIDC 或最新版 SciForge 的跨系统 E2E。

### PostgreSQL restart 验收

只在维护窗口、已经确认备份可用时运行。脚本没有交互式模糊确认，必须给出完整固定参数。正式 Provider 尚未选定、当前运行 core-only 时使用显式 `--core-only`：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-restart.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-postgres-restart \
  --core-only
```

只有 app 已经通过 `deploy-provider-zulip.sh` 显式启用 Zulip 候选 Provider 时，才使用 Provider 模式。为兼容既有运维调用，不给 mode flag 时仍默认为这一严格模式；推荐显式写出 `--provider-zulip`：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-restart.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-postgres-restart \
  --provider-zulip
```

两种模式都会先验证运行 app 的 image ID、image/container revision label、容器内 `CONTRACT_COMMIT` 都等于传入的固定 commit。core-only 模式要求 `core-only-private` label、没有 Provider env/mount 且 catalog 为空；Provider 模式仍严格要求 `zulip-provider-private` label、只读 config/secret mount 和 catalog 恰为 `zulip`（不依赖 app 必须在十分钟内启动），不会因新增 core-only 分支而放宽。随后脚本记录 app/PostgreSQL container ID、PID、RestartCount、commit 和 release 全表 row counts，停止并原位启动 PostgreSQL，要求 `/healthz` 始终返回 `200`、数据库停机窗口内 `/readyz` 精确返回 `503`、恢复后返回 `200`，且 app container/PID/RestartCount 不变、PostgreSQL PID 改变、row counts 完全一致。`trap` 会在中断或失败时尝试恢复 PostgreSQL。

日志检查只输出三个数字，不输出命中行：必须至少有一个安全的 `postgres.pool.idle_client_error`/`57P0x` 诊断（连接池中多个 idle client 可以各自产生一条），且 unhandled、Client object、stack、`secretKey`、`connectionParameters` 和凭据模式计数都为零。

## 6. 资源与兼容性

提交或复制部署资产前，可在任意带 Bash 的可信构建机执行静态策略检查；它会对全部部署 shell 做语法检查，并确认 tunnel、Provider secret 隔离、固定 commit、精确探针状态和失败停机门禁仍存在：

```bash
deploy/collaboration-private/scripts/static-policy-test.sh
```

该部署面向当前 Alibaba Cloud Linux 4、Docker 24.0.9、Docker Compose 2.26.1、4 vCPU、7.3 GiB RAM 的 A ECS。脚本只使用 Compose 2.26.1 已支持的 `config --quiet`、`up --wait`、profiles 和健康依赖，不使用更高版本才提供的 `config --environment`。

默认运行上限：PostgreSQL 1.5 CPU/2 GiB/256 PID，app 1 CPU/768 MiB/256 PID；所有容器使用有界 `json-file` 日志。app 为只读 root filesystem、空 capability set、`no-new-privileges`，并以 Node 镜像的非 root 用户运行。

A 的简易网页控制台已经由同一 server bundle 在 `/console/` 提供，并与 API 共用同源安全边界；它在 loopback 可做 A 内部验收，但在正式入口与链路完成评审和真实端到端验证前不向成员宣称正式可用。B–E 私有模块仍不属于 A。若显式选择 Zulip 做候选 conformance，它也只属于该次验收；不得通过放开 8787、5432、让最新版 SciForge 使用临时 HTTP tunnel 或复制旧实验部署代码来抢先冻结产品链路。
