#!/usr/bin/env node
import { main, reportFailure } from './main.js';
// 仅可执行入口自动启动；库入口不安装服务或退出钩子。
await main().catch(reportFailure);
