import path from "node:path";
import type { GoldenCorpusExpectations } from "../../src/core/contracts/evaluation/evaluate.js";
import type { FileLanguage, RepoNode } from "../../src/core/parsing/types.js";
import { repoId } from "../../src/shared/path.js";

export type GoldenFile = {
  repo: string;
  path: string;
  language: FileLanguage;
};

const FIXTURE_ROOT = path.resolve("tests/fixtures");

const goldenRepoLanguages: Record<string, string> = {
  "service-a": "typescript",
  "service-b": "typescript",
  "service-c": "javascript",
  "service-py": "python",
  "service-go": "go"
};

export const goldenRepos: RepoNode[] = Object.entries(goldenRepoLanguages).map(([name, language]) => ({
  id: repoId(name),
  name,
  path: path.join(FIXTURE_ROOT, name),
  remoteUrl: "",
  branch: "",
  commitSha: "",
  language,
  indexedAt: "golden"
}));

export const goldenFiles: GoldenFile[] = [
  { repo: "service-a", path: "src/OrderController.ts", language: "typescript" },
  { repo: "service-a", path: "src/OrderClient.ts", language: "typescript" },
  { repo: "service-a", path: "src/OrderService.ts", language: "typescript" },
  { repo: "service-b", path: "src/PaymentService.ts", language: "typescript" },
  { repo: "service-b", path: "src/events/OrderCreatedEvent.ts", language: "typescript" },
  { repo: "service-b", path: "README.md", language: "markdown" },
  { repo: "service-c", path: "src/InventoryService.js", language: "javascript" },
  { repo: "service-c", path: "src/InventoryPanel.jsx", language: "jsx" },
  { repo: "service-py", path: "src/app.py", language: "python" },
  { repo: "service-go", path: "src/main.go", language: "go" }
];

export const goldenExpectations: GoldenCorpusExpectations = {
  contracts: [
    { kind: "api", key: "/api/order/{id}" },
    { kind: "api", key: "/grpc/orderservice/getorderstream" },
    { kind: "api", key: "GET:/api/go/orders" },
    { kind: "api", key: "GET:/api/go/users" },
    { kind: "api", key: "GET:/api/local/cache" },
    { kind: "api", key: "POST:/api3/merchant/backstage/service/clientapplication/querycappbybosid" },
    { kind: "api", key: "GET:/api/python/orders" },
    { kind: "api", key: "GET:/api/python/users" },
    { kind: "api", key: "POST:/mall/mgr/entireorder/list" },
    { kind: "api", key: "POST:/mall/mgr/entireorder/{userid}/getdetail" },
    { kind: "api", key: "POST:/mall/mgr/exact/querypagepromotionlist" },
    { kind: "api", key: "POST:/wechatassistant/public/sid/v2/getappconfigstatus" },
    { kind: "api", key: "GET:/api/order/{id}" },
    { kind: "config", key: "ORDER_SHARED_CONFIG" },
    { kind: "config", key: "PAYMENTCONFIG" },
    { kind: "dto", key: "orderdto" },
    { kind: "enum", key: "orderstatus" },
    { kind: "event", key: "order.created" },
    { kind: "package", key: "@fixture/service-a" },
    { kind: "package", key: "@fixture/service-b" },
    { kind: "package", key: "@fixture/service-c" },
    { kind: "package", key: "fastapi" },
    { kind: "package", key: "net/http" },
    { kind: "package", key: "react" },
    { kind: "package", key: "requests" },
    { kind: "schema", key: "orderschema" }
  ],
  participants: [
    { repo: "service-a", role: "consumer", kind: "package", key: "@fixture/service-b" },
    { repo: "service-a", role: "owner", kind: "package", key: "@fixture/service-a" },
    { repo: "service-a", role: "consumer", kind: "api", key: "/api/order/{id}" },
    { repo: "service-a", role: "producer", kind: "api", key: "/api/order/{id}" },
    { repo: "service-a", role: "producer", kind: "event", key: "order.created" },
    { repo: "service-a", role: "shared", kind: "config", key: "ORDER_SHARED_CONFIG" },
    { repo: "service-a", role: "shared", kind: "dto", key: "orderdto" },
    { repo: "service-a", role: "shared", kind: "enum", key: "orderstatus" },
    { repo: "service-a", role: "shared", kind: "schema", key: "orderschema" },
    { repo: "service-b", role: "consumer", kind: "api", key: "/api/order/{id}" },
    { repo: "service-b", role: "consumer", kind: "api", key: "GET:/api/order/{id}" },
    { repo: "service-b", role: "consumer", kind: "api", key: "GET:/api/local/cache" },
    { repo: "service-b", role: "consumer", kind: "api", key: "/grpc/orderservice/getorderstream" },
    { repo: "service-b", role: "consumer", kind: "api", key: "POST:/api3/merchant/backstage/service/clientapplication/querycappbybosid" },
    { repo: "service-b", role: "consumer", kind: "api", key: "POST:/mall/mgr/entireorder/list" },
    { repo: "service-b", role: "consumer", kind: "api", key: "POST:/mall/mgr/entireorder/{userid}/getdetail" },
    { repo: "service-b", role: "consumer", kind: "api", key: "POST:/mall/mgr/exact/querypagepromotionlist" },
    { repo: "service-b", role: "consumer", kind: "api", key: "POST:/wechatassistant/public/sid/v2/getappconfigstatus" },
    { repo: "service-b", role: "consumer", kind: "event", key: "order.created" },
    { repo: "service-b", role: "consumer", kind: "package", key: "@fixture/service-a" },
    { repo: "service-b", role: "owner", kind: "package", key: "@fixture/service-b" },
    { repo: "service-b", role: "shared", kind: "config", key: "ORDER_SHARED_CONFIG" },
    { repo: "service-b", role: "shared", kind: "config", key: "PAYMENTCONFIG" },
    { repo: "service-b", role: "shared", kind: "dto", key: "orderdto" },
    { repo: "service-b", role: "shared", kind: "enum", key: "orderstatus" },
    { repo: "service-b", role: "shared", kind: "schema", key: "orderschema" },
    { repo: "service-c", role: "consumer", kind: "package", key: "@fixture/service-a" },
    { repo: "service-c", role: "consumer", kind: "package", key: "react" },
    { repo: "service-c", role: "owner", kind: "package", key: "@fixture/service-c" },
    { repo: "service-py", role: "producer", kind: "api", key: "GET:/api/python/users" },
    { repo: "service-py", role: "consumer", kind: "api", key: "GET:/api/python/orders" },
    { repo: "service-py", role: "consumer", kind: "package", key: "fastapi" },
    { repo: "service-py", role: "consumer", kind: "package", key: "requests" },
    { repo: "service-go", role: "producer", kind: "api", key: "GET:/api/go/users" },
    { repo: "service-go", role: "consumer", kind: "api", key: "GET:/api/go/orders" },
    { repo: "service-go", role: "consumer", kind: "package", key: "net/http" }
  ],
  dependencies: [
    { fromRepo: "service-a", toRepo: "service-b", dependencyType: "package", kind: "package", key: "@fixture/service-b" },
    { fromRepo: "service-a", toRepo: "service-b", dependencyType: "shared-contract", kind: "config", key: "ORDER_SHARED_CONFIG" },
    { fromRepo: "service-a", toRepo: "service-b", dependencyType: "shared-contract", kind: "dto", key: "orderdto" },
    { fromRepo: "service-a", toRepo: "service-b", dependencyType: "shared-contract", kind: "enum", key: "orderstatus" },
    { fromRepo: "service-a", toRepo: "service-b", dependencyType: "shared-contract", kind: "schema", key: "orderschema" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "api", kind: "api", key: "/api/order/{id}" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "api", kind: "api", key: "GET:/api/order/{id}" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "event", kind: "event", key: "order.created" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "import", kind: "package", key: "@fixture/service-a" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "shared-contract", kind: "config", key: "ORDER_SHARED_CONFIG" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "shared-contract", kind: "dto", key: "orderdto" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "shared-contract", kind: "enum", key: "orderstatus" },
    { fromRepo: "service-b", toRepo: "service-a", dependencyType: "shared-contract", kind: "schema", key: "orderschema" },
    { fromRepo: "service-c", toRepo: "service-a", dependencyType: "import", kind: "package", key: "@fixture/service-a" },
    { fromRepo: "service-c", toRepo: "service-a", dependencyType: "package", kind: "package", key: "@fixture/service-a" }
  ],
  absentContracts: [
    { kind: "api", key: "/config", reason: "local config reads must not be promoted to API dependencies" },
    { kind: "api", key: "/api/python/local-cache", reason: "same-named local Python utility methods must not be promoted to HTTP API dependencies" },
    { kind: "api", key: "/api/go/local-cache", reason: "same-named local Go utility methods must not be promoted to HTTP API dependencies" },
    { kind: "api", key: "/api/order/${id}", reason: "template/parameter variants should canonicalize to /api/order/{id}" },
    { kind: "event", key: "order.paid", reason: "unmentioned events should stay absent" },
    { kind: "package", key: "typescript", reason: "dev tooling packages should not appear unless fixture declares them" }
  ]
};
