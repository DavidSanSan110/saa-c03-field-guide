// The question id format, shared by the question and progress schemas (not exported from the index).
import { z } from 'zod';

const ID_PATTERN = /^d[1-4]-[1-4]\.\d-\d{4}$/;

export const questionIdSchema = z
  .string()
  .regex(ID_PATTERN, 'must look like d<domain>-<task>-<4 digits>');
