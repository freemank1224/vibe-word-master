# 中文释义后台回填运维

后台回填使用数据库全局门闩，最多每五分钟完成一个单词的处理，并在受限时遵守服务返回的等待时间。定时器每五分钟检查一次，因此正常处理速度可能低于每五分钟一个。共享项目中其他应用也会消耗配额，不能保证服务永不返回 429。

检查状态时，只读取是否存在租约和等待时间，不要输出或分享租约令牌、Vault 内容、请求头或密钥：

```sql
select lease_token is not null as has_lease, lease_until, next_allowed_at
from public.lexeme_backfill_rate_gate where singleton;

select status, count(*) from public.lexeme_meaning_backfill_jobs
group by status order by status;
```

当供应商或数据库要求长时间等待、无法保存等待期限，或工作进程在领取租约后异常退出时，门闩可能保持关闭。恢复前先检查 Edge Function 与定时任务日志、确认没有工作进程仍在运行，并确认供应商要求的等待时间已经结束。不要为了清理积压而直接重置等待时间或批量手工调用服务。

定时任务使用 Vault 中的专用凭据和私有同步 HTTP 扩展，不通过 `pg_net` 的请求队列传递凭据。凭据应在 Supabase 的安全配置中轮换，不应写入仓库、日志或工单。手动添加单词的中文释义不依赖这个后台任务。
