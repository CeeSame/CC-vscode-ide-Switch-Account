# Claude Skills 迁移包

用于在新机器上快速还原本机的 Claude Code Skills 配置。

## 目录结构

```
skills-migration/
├── restore.sh                        ← 一键还原脚本
├── README.md                         ← 本文件
│
├── user-skills/                      ← 全局 Skills（还原到 ~/.claude/skills/）
│   ├── context-loader/               ← 项目快速启动 & 存档
│   ├── skill-creator/                ← 创建/优化 Skills 的元技能
│   ├── structured-reasoner/          ← 系统化推理规范
│   └── vibe-coding-cn/               ← AI辅助编程行为规范
│
└── project-skills/                   ← 项目级 Skills（需指定目标项目路径）
    └── AiVideo/
        ├── CLAUDE.md                 ← AiVideo 项目工作流文档
        └── claude-config/skills/     ← 对应项目的 .claude/（因 .claude 被 gitignore 故改名）
            └── seedance-storyboard-generator/
                ├── SKILL.md          ← AI视频脚本&分镜生成器
                └── references/       ← 7个参考文档
                    ├── seedance-manual.md
                    ├── 可灵AI提示词规范.md
                    ├── SLG买量广告创意手册.md
                    ├── 好剧本.md
                    ├── 优化分镜.md
                    ├── 3组可套用提示词.md
                    └── 故事转视频脚本-转换工具.md
```

## 迁移方法

### 方法一：一键脚本（推荐）

```bash
bash restore.sh
```

脚本会：
1. 自动将 `user-skills/` 下的所有 Skills 复制到 `~/.claude/skills/`
2. 交互式询问 `project-skills/` 中每个项目的本机路径，复制到对应位置

### 方法二：手动复制

**用户级 Skills：**
```bash
cp -r user-skills/* ~/.claude/skills/
```

**AiVideo 项目 Skills（假设项目在 ~/projects/AiVideo）：**
```bash
cp -r project-skills/AiVideo/claude-config ~/projects/AiVideo/.claude
cp project-skills/AiVideo/CLAUDE.md ~/projects/AiVideo/CLAUDE.md
```

## 还原后

重启 Claude Code，Skills 即可生效：
- `/context-loader` — 项目快速启动
- `/skill-creator` — 创建/优化 Skills
- `/structured-reasoner` — 系统化推理
- `/vibe-coding-cn` — 编程规范
- `/seedance-storyboard-generator` — AI视频脚本生成（在 AiVideo 项目中）

## 注意事项

- 官方插件市场的 Skills（discord/telegram/mcp-server-dev 等）**不在此包中**，在新机器上重新从插件市场安装即可
- `user-skills/` 中的 Skills 对所有项目生效
- `project-skills/` 中的 Skills 只对对应项目生效，需放在项目的 `.claude/skills/` 目录下
