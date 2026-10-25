import { hollow } from './hollow';
import { lowpoly } from './lowpoly';
import { stipple, STIPPLE_MAX_DOTS } from './stipple';
import type { OutlineOp } from '../types';

export { hollow, lowpoly, stipple, STIPPLE_MAX_DOTS };

export const OUTLINE_OPS: Record<string, OutlineOp> = { hollow, lowpoly, stipple };
