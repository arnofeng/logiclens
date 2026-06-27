export const tsQueries = {
  imports: `
    (import_statement
      (import_clause
        (identifier) @import.default
      )?
      (import_clause
        (namespace_import
          (identifier) @import.namespace
        )
      )?
      (import_clause
        (named_imports
          (import_specifier
            name: (identifier) @import.named.name
            alias: (identifier)? @import.named.alias
          )
        )
      )?
      source: (string) @import.source
    ) @import

    (export_statement
      (namespace_export
        (identifier) @export.namespace
      )?
      (export_clause
        (export_specifier
          name: (identifier) @export.named.name
          alias: (identifier)? @export.named.alias
        )
      )?
      source: (string) @import.source
    ) @import
  `,
  symbols: `
    (class_declaration
      name: [(type_identifier) (identifier)] @class.name) @class

    (method_definition
      name: [
        (property_identifier)
        (private_property_identifier)
      ] @method.name) @method

    (function_declaration
      name: (identifier) @function.name) @function

    (interface_declaration
      name: (type_identifier) @interface.name) @interface

    (type_alias_declaration
      name: (type_identifier) @type.name) @type

    (enum_declaration
      name: (identifier) @enum.name) @enum

    (variable_declarator
      name: (identifier) @variable.name
      value: [
        (arrow_function)
        (function_expression)
      ]) @variable
  `,
  calls: `
    (call_expression
      function: [
        (identifier) @call.name
        (member_expression
          property: (property_identifier) @call.name)
      ]) @call

    (new_expression
      constructor: [
        (identifier) @call.name
        (member_expression
          property: (property_identifier) @call.name)
      ]) @call
  `
};

export const jsQueries = {
  imports: tsQueries.imports,
  symbols: `
    (class_declaration
      name: (identifier) @class.name) @class

    (method_definition
      name: [
        (property_identifier)
        (private_property_identifier)
      ] @method.name) @method

    (function_declaration
      name: (identifier) @function.name) @function

    (variable_declarator
      name: (identifier) @variable.name
      value: [
        (arrow_function)
        (function_expression)
      ]) @variable
  `,
  calls: tsQueries.calls
};
