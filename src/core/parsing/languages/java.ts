export const javaQueries = {
  imports: `
    (import_declaration
      [
        (scoped_identifier) @import.source
        (identifier) @import.source
        (asterisk) @import.source
      ]) @import
  `,
  symbols: `
    (class_declaration
      name: (identifier) @class.name) @class

    (interface_declaration
      name: (identifier) @interface.name) @interface

    (enum_declaration
      name: (identifier) @enum.name) @enum

    (method_declaration
      name: (identifier) @method.name) @method

    (constructor_declaration
      name: (identifier) @method.name) @method
  `,
  calls: `
    (method_invocation
      name: (identifier) @call.name) @call

    (object_creation_expression
      type: (_) @call.name) @call
  `,
  variables: `
    (field_declaration
      type: (_) @variable.type
      declarator: (variable_declarator
        name: (identifier) @variable.name)) @variable

    (local_variable_declaration
      type: (_) @variable.type
      declarator: (variable_declarator
        name: (identifier) @variable.name)) @variable
  `
};
