import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";

describe("Docstring Extraction", () => {
  it("extracts and cleans comments/docstrings for TypeScript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-docstring-ts-"));
    const sourcePath = path.join(dir, "Test.ts");
    await fs.writeFile(
      sourcePath,
      `
/**
 * This is a JSDoc comment.
 * @param val some value
 */
export class TestClass {
  // Single line comment
  myMethod() {}
}

/**
 * A constant function.
 */
export const myFunc = () => {};
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("docstring-ts"),
      absolutePath: sourcePath,
      relativePath: "Test.ts",
      language: "typescript"
    });

    const testClass = parsed.symbols.find((s) => s.name === "TestClass");
    expect(testClass).toBeDefined();
    expect(testClass?.summary).toBe("This is a JSDoc comment.\n@param val some value");

    const myMethod = parsed.symbols.find((s) => s.name === "myMethod");
    expect(myMethod).toBeDefined();
    expect(myMethod?.summary).toBe("Single line comment");

    const myFunc = parsed.symbols.find((s) => s.name === "myFunc");
    expect(myFunc).toBeDefined();
    expect(myFunc?.summary).toBe("A constant function.");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extracts and cleans comments/docstrings for Java", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-docstring-java-"));
    const sourcePath = path.join(dir, "Test.java");
    await fs.writeFile(
      sourcePath,
      `
package com.example.test;

/**
 * Java class doc.
 */
public class TestJava {
  // Method comment
  public void run() {}
}
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("docstring-java"),
      absolutePath: sourcePath,
      relativePath: "Test.java",
      language: "java"
    });

    const testJava = parsed.symbols.find((s) => s.name === "TestJava");
    expect(testJava).toBeDefined();
    expect(testJava?.summary).toBe("Java class doc.");

    const runMethod = parsed.symbols.find((s) => s.name === "run");
    expect(runMethod).toBeDefined();
    expect(runMethod?.summary).toBe("Method comment");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extracts and cleans comments/docstrings for Go", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-docstring-go-"));
    const sourcePath = path.join(dir, "main.go");
    await fs.writeFile(
      sourcePath,
      `
package main

// Config struct doc
// multiple lines
type Config struct {}

// run doc
func run() {}
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("docstring-go"),
      absolutePath: sourcePath,
      relativePath: "main.go",
      language: "go"
    });

    const configStruct = parsed.symbols.find((s) => s.name === "Config");
    expect(configStruct).toBeDefined();
    expect(configStruct?.summary).toBe("Config struct doc\nmultiple lines");

    const runFunc = parsed.symbols.find((s) => s.name === "run");
    expect(runFunc).toBeDefined();
    expect(runFunc?.summary).toBe("run doc");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extracts and cleans comments/docstrings for Python", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-docstring-py-"));
    const sourcePath = path.join(dir, "main.py");
    await fs.writeFile(
      sourcePath,
      `
class PyClass:
    """
    Class docstring.
    
    Detail info.
    """
    def my_method(self):
        '''
        Method docstring.
        '''
        pass

# Preceding comment
def another():
    pass
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("docstring-py"),
      absolutePath: sourcePath,
      relativePath: "main.py",
      language: "python"
    });

    const pyClass = parsed.symbols.find((s) => s.name === "PyClass");
    expect(pyClass).toBeDefined();
    expect(pyClass?.summary).toBe("Class docstring.\n\nDetail info.");

    const myMethod = parsed.symbols.find((s) => s.name === "my_method");
    expect(myMethod).toBeDefined();
    expect(myMethod?.summary).toBe("Method docstring.");

    const another = parsed.symbols.find((s) => s.name === "another");
    expect(another).toBeDefined();
    expect(another?.summary).toBe("Preceding comment");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extracts Python raw docstrings without prefixes or quotes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-docstring-py-raw-"));
    const sourcePath = path.join(dir, "main.py");
    await fs.writeFile(
      sourcePath,
      `
def raw_doc():
    r"""
    Raw path docs.
    C:\\\\tmp
    """
    pass

def unicode_raw_doc():
    R'''
    Upper raw docs.
    '''
    pass
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("docstring-py-raw"),
      absolutePath: sourcePath,
      relativePath: "main.py",
      language: "python"
    });

    const rawDoc = parsed.symbols.find((s) => s.name === "raw_doc");
    expect(rawDoc).toBeDefined();
    expect(rawDoc?.summary).toBe("Raw path docs.\nC:\\\\tmp");

    const unicodeRawDoc = parsed.symbols.find((s) => s.name === "unicode_raw_doc");
    expect(unicodeRawDoc).toBeDefined();
    expect(unicodeRawDoc?.summary).toBe("Upper raw docs.");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
