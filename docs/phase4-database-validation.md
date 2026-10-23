# 阶段 4 数据库迁移与验证

2026-10-22（America/New_York）。目标为项目现有 Supabase 官方线上实例 `mkdxdlsjisqazermmfoe`（VocabularyVibe，PostgreSQL 17.6）。使用已有 Supabase CLI 授权；插件连接没有该组织的权限，CLI 已确认目标项目为 linked / ACTIVE_HEALTHY。

## 已应用的增量迁移

以下迁移已在目标线上数据库执行，并同时写入 `supabase_migrations.schema_migrations`。前三份使用一个事务，账号绑定修复使用独立事务。没有重放其他历史迁移，没有对真实用户记录做迁移回填。

| 版本 | 内容 |
| --- | --- |
| `20261022155313` | `words.review_state` |
| `20261023030246` | 原始学习事件、逐词版本、CAS 投影、跨端恢复、旧快照保护 |
| `20261023031408` | 完成事件幂等、原始日期统计、统计与金币同事务、今日统计时区修正 |
| `20261023033057` | 完成事件绑定原账号，切换账号时拒绝错误归属，移除无绑定旧签名 |

生产执行前先将这些 DDL 和 SQL 回归放进一个线上事务，全部通过后 `ROLLBACK`；随后才正式应用。旧 `get_todays_stats` 函数定义已在执行机器的临时恢复文件中保存。迁移版本时间戳由 Supabase CLI 生成，使用 UTC，因此日期部分为 10 月 23 日。

## 同步契约

- `append_learning_events_v1(p_events jsonb)`：单次 1–500 事件、最多 100 词。同一用户和事件 ID 只能对应同一内容；重试不增加版本。事件保存发生时间，迟到错误保留。
- `get_learning_replay_v1(p_word_ids uuid[])`：返回不可变初始学习快照和完整原始事件，按发生时间及事件 ID 排序。
- `commit_learning_projection_v1(p_word_id uuid, p_revision bigint, p_patch jsonb)`：仅当事件版本仍匹配时更新单词；明确返回 `committed` 和版本。客户端重放使用现有 TypeScript 调度器，SQL 不复制间隔算法。
- `get_unprojected_learning_replays_v1(p_limit integer = 50)`：其他设备可恢复“事件已上传、原设备在投影前关闭”的记录。
- `record_test_event_v1(p_event_id text, p_occurred_at timestamptz, p_test_count integer, p_correct_count integer, p_points numeric, p_expected_user_id uuid)`：同一完成事件只增加一次统计和金币；原始发生时间决定上海日期。迟到的合法事件可追加到冻结日，冻结标记保留。账号必须与 `auth.uid()` 一致，避免读取登录状态后切换账号导致错记。

`words.learning_revision` 始终表示已经提交的投影版本。事件管理开始后，旧客户端直接修改学习字段会被数据库触发器恢复为已提交投影，普通词汇资料更新仍可写。新九宫格和 Orbit 仍为练习模式，不接入正式游戏排名或金币奖励。

## 官方线上验证证据

`supabase/tests/phase4_event_sync.sql` 包含 **38 项 SQL 断言**：重复/篡改事件、迟到事件、版本竞争、投影重试、旧快照保护、跨账号/匿名拒绝、直接表访问拒绝、无记录不能冒充成功、冻结日追加、上海午夜边界、统计与金币的重试去重，以及完成事件账号不符、账号为空、旧无绑定接口不可调用。测试全部使用事务内随机用户，最终回滚所有用户、词汇、钱包和排名副作用。

`supabase/tests/phase4-online-concurrency.mjs` 对同一官方项目进行真实 HTTP 并发，使用独立临时 Auth 用户：

1. 32 个同时上传请求对应 16 个唯一事件，最终版本和事件数均为 16。
2. 迟到错误使旧设备的版本提交失败，事件未丢失。
3. 8 个同时重试的 CAS 提交结果一致，数据库投影与 TypeScript 调度器结果一致。
4. 第二设备使用空本地存储，成功恢复原设备未完成的投影。
5. 完成事件账号不匹配和缺少原账号参数的 HTTP 请求被拒绝。
6. 同一完成事件 12 个并发请求只计一次、只奖励一次。
7. 4 个不同完成事件并发追加，统计增量和金币流水均没有丢失。
8. 匿名 HTTP RPC 请求被拒绝。

第一次并发测试在统计请求阶段遇到一次 TLS 连接重置。回归脚本仅为幂等 RPC、读取和删除增加有限次同参数网络重试后，以上 8 组全部通过；没有改为不幂等的回退路径。

部署后确认 3 个私有表全部启用 RLS，`anon`/`authenticated` 无直接表权限，公开 RPC 均为 `SECURITY INVOKER`，内部权限函数位于私有 schema 并显式验证 `auth.uid()`。官方 security advisors 从既有 **123 项降至 120 项，新增 0 项**；减少的是旧今日统计函数的搜索路径与公开权限问题。其余既有告警不属于本轮全部修复范围。

## 重跑与清理

SQL 回归只在明确授权的线上项目运行：

```sh
supabase db query --linked --file supabase/tests/phase4_event_sync.sql
```

HTTP 并发脚本要求临时 QA 用户的本机凭证文件，禁止使用真实学习账号。凭证位于仓库外、权限 `0600`，脚本不输出密码或令牌：

```sh
node supabase/tests/phase4-online-concurrency.mjs /tmp/vocab-phase4-qa-credentials.json
```

完整浏览器验收结束后，执行专属账号清理脚本：

```sh
node supabase/tests/cleanup-phase4-qa.mjs /tmp/vocab-phase4-qa-credentials.json --delete
```

**2026-10-23（America/New_York）已完成实际清理。** 浏览器已退出登录；清理脚本已删除专属 QA 用户的业务记录和 Auth 身份，并重新计算受临时排名影响的日期。随后确认 Auth 用户、Auth 身份、词汇、词库、每日统计、测试明细、钱包、金币流水、排行榜、学习事件、完成事件共 11 类记录均为 **0 遗留**，本机凭证文件也已删除。没有删除其他账号。

清理前的完整浏览器验收通过：12 词共 36 条学习事件全部在云端投影，待同步事件为 0；普通测验 12/12、36 分，金币仅奖励一次且刷新后保持一致；3 条断网退出事件在恢复网络并刷新后全部自动上传。实际清理结果记录于执行机器的 `/tmp/vocab-phase4-cleanup-result.json`，浏览器结果位于 `/tmp/vocab-phase4-browser-result.json`，两者均不含密码或令牌。

## 边界

这轮已验证官方线上 PostgreSQL、PostgREST、Auth 和并发 RPC。运行环境与最终浏览器全流程由总体验收报告记录。复习曲线仍为可校准启发式算法；事件投影由登录客户端确定，不等同于服务端防作弊评分。事件记录暂不压缩，后续可增加可审计检查点以控制长期回放量。
