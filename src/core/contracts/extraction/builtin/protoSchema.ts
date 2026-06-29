import schema from "protocol-buffers-schema";
import { logger } from "../../../../shared/logger.js";

export interface Field {
  name: string;
  type: string;
  tag: number;
  map: {
    from: string;
    to: string;
  } | null;
  oneof: null | string;
  required: boolean;
  repeated: boolean;
  optional?: boolean;
  options: Record<string, string>;
}

export interface Message {
  name: string;
  enums: any[];
  extends: any[];
  extensions: any[];
  messages: Message[];
  options: Record<string, any>;
  fields: Field[];
}

export interface Method {
  name: string;
  input_type: string;
  output_type: string;
  client_streaming: boolean;
  server_streaming: boolean;
  options: Record<string, any>;
}

export interface Service {
  name: string;
  methods: Method[];
  options: Record<string, any>;
}

export interface ProtoSchema {
  syntax: number;
  package: null | string;
  imports: string[];
  enums: any[];
  messages: Message[];
  options: Record<string, any>;
  extends: any[];
  services?: Service[];
}

/**
 * Parses a .proto file's source code into a structured schema object.
 * Returns undefined on error to maintain parser pipeline resilience.
 */
export function parseProto(source: string): ProtoSchema | undefined {
  try {
    return schema.parse(source) as unknown as ProtoSchema;
  } catch (err) {
    logger.warn("Failed to parse proto file schema: %s", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
