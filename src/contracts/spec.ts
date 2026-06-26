export type HttpEndpointSpec = {
  kind: "http-endpoint";
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  path: string;
  pathTemplate: string;
  pathParams: string[];
  queryParams?: { name: string; type?: string; required?: boolean }[];
  requestBodyType?: string;
  responseBodyType?: string;
  statusCodes?: number[];
  auth?: "unknown" | "none" | "required";
};

export type EventSpec = {
  kind: "event";
  topic: string;
  eventName?: string;
  payloadType?: string;
  keyType?: string;
  broker?: "kafka" | "rabbitmq" | "redis-stream" | "nats" | "unknown";
  version?: string;
};

export type SchemaFieldSpec = {
  name: string;
  type: string;
  optional: boolean;
  nullable?: boolean;
  sourceLine?: number;
};

export type SchemaSpec = {
  kind: "schema";
  name: string;
  language: string;
  fields: SchemaFieldSpec[];
};

export type ContractSpec = HttpEndpointSpec | EventSpec | SchemaSpec;

export function serializeSpec(spec: ContractSpec): string {
  return JSON.stringify(spec);
}

export function deserializeSpec(json: string): ContractSpec {
  return JSON.parse(json) as ContractSpec;
}
