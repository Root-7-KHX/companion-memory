---
name: 申请收录软件
about: 把一个外部软件 / 通道登记到「AI记忆 · 接入软件」目录
title: "申请收录："
labels: ""
assignees: ""
---

## 软件名称

<!-- 例如：QQ 机器人 -->

## 一句话说明

<!-- 它能干什么、能给 AI记忆 带进来什么（这条会显示在卡片上） -->

## 作者 / 维护者

<!-- 你的名字或 GitHub 用户名 -->

## 主页 / 下载地址

<!-- https://... 只支持 http(s) -->

## 分类与标签（可选）

<!-- 分类示例：通道 / 工具 / 记忆；标签示例：QQ、IM、群聊 -->

## 它怎么和 AI记忆 配合（可选）

<!-- 例如：把群消息写进记忆（POST /companion/api/memory/add）、把好感度写回等等 -->

## 清单 JSON（推荐直接贴，格式见 docs/接入软件.md）

```json
{
  "id": "your-software",
  "name": "软件名称",
  "description": "一句话说明",
  "version": "1.0.0",
  "author": "你的名字",
  "category": "通道",
  "tags": ["标签"],
  "capabilities": ["能力"],
  "homepage": "https://github.com/you/your-software"
}
```

## 备注

<!-- 需要说明的限制、截图、其它链接都可以放这里 -->
