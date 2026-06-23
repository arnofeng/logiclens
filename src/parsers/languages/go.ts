export const goQueries = {
  imports: `
    (import_spec
      path: (_) @import.source) @import
  `,
  symbols: `
    (type_spec
      name: (type_identifier) @struct.name
      type: (struct_type)) @struct

    (type_spec
      name: (type_identifier) @interface.name
      type: (interface_type)) @interface

    (function_declaration
      name: (identifier) @function.name) @function

    (method_declaration
      name: (field_identifier) @method.name) @method
  `,
  calls: `
    (call_expression
      function: [
        (identifier) @call.name
        (selector_expression
          field: (field_identifier) @call.name)
      ]) @call
  `
};
