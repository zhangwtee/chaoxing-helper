# 学习通助手 · chaoxing-helper

一个 [Tampermonkey](https://www.tampermonkey.net/) 用户脚本，用于超星学习通（chaoxing.com）课程页面：按顺序刷视频/文档任务点，自动解密测验乱码题干，用本地题库或 AI 答题，可选择答完自动交卷。

## 功能

- **刷课**：按章节顺序播放视频任务点，播完回读服务端进度核对；文档任务点模拟阅读（滚动/翻页/鼠标移动）
- **测验解密**：还原学习通 font-cxsecret 字体反爬，题干乱码自动变回正常文字
- **答题**：本地题库 → tikuAdapter → AI 大模型，三层依次查答案
- **交卷**：默认自己提交；可勾选「答完自动提交」，全答完且无留空才自动交
- **阅读模式**：需要阅读时长的任务用慢速单向滚动、不自动刷新、跨日等待窗口
- **面板**：状态灯、进度、日志、按钮大小调节，全部设置本地保存

## 安装

1. 浏览器安装 Tampermonkey 插件
2. 安装本脚本：[chaoxing-all.user.js](./chaoxing-all.user.js)（点进文件后点 "Raw" 复制内容，或点文件名安装）
3. 打开学习通课程章节页，面板出现在页面右上角

## 配置（可选）

答题功能需要先配置数据源，否则只能刷课：

| 来源 | 配置位置 | 说明 |
|---|---|---|
| 本地题库 | 面板 → 设置 → 题库 | 填 tikuAdapter 服务地址，如 `http://localhost:8060/adapter-service/search` |
| AI 大模型 | 面板 → 设置 → AI | 填 API 地址、Key、模型名（兼容 OpenAI 格式，如 DeepSeek） |

两项都是可选的，至少配一项才能答题。**API Key 只存在你自己的浏览器里**（Tampermonkey 隔离存储 + localStorage 备份），不会写进本仓库，也不会上传。

详细用法见 [使用说明.md](./使用说明.md)。

## 字库

测验题干解密依赖 [font-table.json](./font-table.json)（约 348 KB，20906 条映射），脚本通过油猴 `@resource` 从本仓库的 raw 链接加载：

```
https://raw.githubusercontent.com/zhangwtee/chaoxing-helper/main/font-table.json
```

字库是第三方作品，来源与授权见下方「版权声明」。**仓库需保持公开**，否则 raw 链接无法匿名访问，字库解密会失效。

## 版权声明

本项目自身代码未附加开源许可证（保留所有权利）。所依赖的第三方组件版权归各自作者所有，均以 MIT 许可证发布：

| 组件 | 用途 | 作者 | 许可证 |
|---|---|---|---|
| `font-table.json` | 字体反爬解密字库 | wyn665817 (wyn665817@163.com)，v20220515.1，原来源 forestpolice.org | MIT |
| [Typr.js](https://github.com/photopea/Typr.js) | 解析字体轮廓 | Photopea, 2016 | MIT |
| [blueimp-md5](https://github.com/blueimp/JavaScript-MD5) | MD5 计算 | Sebastian Tschan, 2011 | MIT |

各组件的完整版权声明与 MIT 许可原文见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 免责声明

本工具仅供学习交流使用。使用自动刷课/答题可能违反所在平台或学校的服务条款与学术规范，**由此产生的后果（包括但不限于账号封禁、成绩作废）由使用者自行承担**。作者不对使用本工具造成的任何后果负责。
