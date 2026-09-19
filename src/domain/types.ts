/** 领域类型的统一出口；只转出类型，避免上层为类型引用加载 Schema 实现。 */
export type {
  AgentConfig,
  AgentPatch,
  Environment,
  EnvValue,
  PermissionPolicy,
  Settings,
} from './schemas.js';
export type { ErrorDetail } from './errors.js';
