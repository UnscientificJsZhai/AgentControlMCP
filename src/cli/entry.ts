#!/usr/bin/env node
import { main, reportFailure } from './main.js';
await main().catch(reportFailure);
