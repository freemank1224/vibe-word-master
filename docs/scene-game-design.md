# Scene Game 下线记录

2026-10-22：Scene Game 已从本仓库的应用源码中移除。此前的场景导演、融合图生成与场景填空设计已停止使用；旧版设计可从 Git 历史查看。

删除范围包括游戏入口、组件、专属服务和类型、管理后台场景页、专属测试，以及场景生成和语音的 Edge Function 源文件。游戏入口保留 Word Strike 与九宫格。

通用词性解析已迁至 `utils/wordPartOfSpeech.ts`；共享单词图片生成、发音、金币及怪兽素材继续使用。

历史数据库迁移与场景数据保留，未执行远端删除或部署。源码移除不会自动关闭已经部署的场景函数。全局管理员校验沿用的 `SCENE_ADMIN_PANEL_PASSWORD` secret 名称保留。

后续方向见 [项目架构与游戏体验改进方案](game-experience-plan.md)。
