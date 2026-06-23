export const pythonQueries = {
  imports: `
    (import_statement) @import
    (import_from_statement) @import
  `,
  symbols: `
    (class_definition
      name: (identifier) @class.name) @class

    (class_definition
      body: (block
        [
          (function_definition
            name: (identifier) @method.name) @method
          (decorated_definition
            (function_definition
              name: (identifier) @method.name) @method)
        ]))

    (function_definition
      name: (identifier) @function.name) @function
  `,
  calls: `
    (call
      function: [
        (identifier) @call.name
        (attribute
          attribute: (identifier) @call.name)
      ]) @call
  `
};
