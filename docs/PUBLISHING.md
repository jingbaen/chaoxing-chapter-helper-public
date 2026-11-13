# GitHub 仓库与后续发布

公开仓库： https://github.com/jingbaen/chaoxing-chapter-helper-public
公开仓库只包含本副本审核后的文件，以独立提交开始，不导入其他仓库的提交历史、分支、Issue 或 Release。
仓库根目录直接包含 `manifest.json`，MIT 许可证和忽略规则已就位。

上传前运行 `npm run verify`。上传本副本中的源码、文档、脚本、测试及隐藏配置文件；不要上传原目录、历史 ZIP、诊断或浏览器数据。
后续可通过 GitHub 网页或本地 Git 客户端更新。上传代码与创建 Release 是独立操作。

`npm run package` 会生成 `dist/chaoxing-chapter-helper-1.0.6.zip`，只包含安装必需文件和许可证，适合作为 Release 附件。
完整源码归档适合初始化仓库；扩展安装 ZIP 不能代替开源仓库的完整源码。

1.0.6 以预发布版本提供：包含诊断脱敏、HTTP UUID 兼容处理，以及关闭/导航后的会话清理修复；27 项本地回归测试通过，真实课程兼容性尚待实页验收。
创建仓库后可启用私密漏洞报告；不要在 Issue 中要求他人提供课程账号或未脱敏链接。
