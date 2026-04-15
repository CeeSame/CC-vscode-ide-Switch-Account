#!/usr/bin/env bash
# ============================================================
# Claude Skills 一键迁移还原脚本
# 用法：bash restore.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="$HOME/.claude"

echo "======================================================"
echo "  Claude Skills 迁移还原"
echo "======================================================"
echo ""

# ── 1. 用户级 Skills → ~/.claude/skills/ ──────────────────
echo "[1/2] 还原用户级 Skills → $CLAUDE_HOME/skills/"
echo ""

USER_SKILLS_SRC="$SCRIPT_DIR/user-skills"

for skill_dir in "$USER_SKILLS_SRC"/*/; do
  skill_name="$(basename "$skill_dir")"
  dest="$CLAUDE_HOME/skills/$skill_name"

  if [ -d "$dest" ]; then
    echo "  ⚠  $skill_name 已存在，跳过（如需覆盖请手动删除后重运行）"
  else
    mkdir -p "$dest"
    cp -r "$skill_dir"* "$dest/"
    echo "  ✅ $skill_name → $dest"
  fi
done

echo ""

# ── 2. 项目级 Skills → 指定项目目录 ───────────────────────
echo "[2/2] 还原项目级 Skills"
echo ""
echo "  以下项目 Skills 需要手动指定目标项目路径："
echo ""

PROJECT_SKILLS_SRC="$SCRIPT_DIR/project-skills"

for project_dir in "$PROJECT_SKILLS_SRC"/*/; do
  project_name="$(basename "$project_dir")"
  echo "  项目：$project_name"
  echo "  内容：$(find "$project_dir" -type f | wc -l) 个文件"
  echo ""
  echo "  请输入该项目在本机的路径（直接回车跳过）："
  read -r target_path

  if [ -z "$target_path" ]; then
    echo "  ⏭  已跳过 $project_name"
  elif [ ! -d "$target_path" ]; then
    echo "  ❌ 路径不存在：$target_path，已跳过"
  else
    # 复制 claude-config/ 目录（对应项目的 .claude/）
    if [ -d "$project_dir/claude-config" ]; then
      dest_claude="$target_path/.claude"
      mkdir -p "$dest_claude"
      cp -rn "$project_dir/claude-config/"* "$dest_claude/" 2>/dev/null || true
      echo "  ✅ claude-config/ → $dest_claude"
    fi
    # 复制 CLAUDE.md（如果目标不存在）
    if [ -f "$project_dir/CLAUDE.md" ]; then
      if [ -f "$target_path/CLAUDE.md" ]; then
        echo "  ⚠  CLAUDE.md 已存在，跳过（源文件在 $project_dir/CLAUDE.md）"
      else
        cp "$project_dir/CLAUDE.md" "$target_path/CLAUDE.md"
        echo "  ✅ CLAUDE.md → $target_path/CLAUDE.md"
      fi
    fi
    # 复制项目说明指引.md
    if [ -f "$project_dir/项目说明指引.md" ]; then
      if [ -f "$target_path/项目说明指引.md" ]; then
        echo "  ⚠  项目说明指引.md 已存在，跳过"
      else
        cp "$project_dir/项目说明指引.md" "$target_path/项目说明指引.md"
        echo "  ✅ 项目说明指引.md → $target_path/"
      fi
    fi
    # 复制 写剧本和分镜/SLG买量项目/使用指南.md
    local_guide="$project_dir/写剧本和分镜/SLG买量项目/使用指南.md"
    if [ -f "$local_guide" ]; then
      dest_guide="$target_path/写剧本和分镜/SLG买量项目/使用指南.md"
      if [ -f "$dest_guide" ]; then
        echo "  ⚠  使用指南.md 已存在，跳过"
      else
        mkdir -p "$target_path/写剧本和分镜/SLG买量项目"
        cp "$local_guide" "$dest_guide"
        echo "  ✅ 使用指南.md → $target_path/写剧本和分镜/SLG买量项目/"
      fi
    fi
    # 复制 魔法书项目/
    if [ -d "$project_dir/魔法书项目" ]; then
      dest_magic="$target_path/魔法书项目"
      if [ -d "$dest_magic" ]; then
        echo "  ⚠  魔法书项目/ 已存在，跳过"
      else
        cp -r "$project_dir/魔法书项目" "$dest_magic"
        echo "  ✅ 魔法书项目/ → $dest_magic"
      fi
    fi
  fi
  echo ""
done

echo "======================================================"
echo "  还原完成！重启 Claude Code 后 Skills 即可生效"
echo "======================================================"