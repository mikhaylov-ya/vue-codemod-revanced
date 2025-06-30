import type { ASTTransformation } from '../src/wrapAstTransformation'

const IGNORED_OPTIONS = ['name', 'components'];
const LIFECYCLE_METHODS = {
  created: 'onCreated',
  beforeMount: 'onBeforeMount',
  mounted: 'onMounted',
  beforeUpdate: 'onBeforeUpdate',
  updated: 'onUpdated',
  beforeUnmount: 'onBeforeUnmount',
  unmounted: 'onUnmounted',
  errorCaptured: 'onErrorCaptured',
};

const OPTIONS_ORDER = ['data', 'props', 'emits', 'setup', 'computed', 'methods'];
export const transformAST: ASTTransformation = (context) => {
  /** @type {JSCodeShift} */
  let { j, root, filename } = context

  // Add these variables at the top of the module function to track what's been added
let hasUserImport = false;
let hasInjectImport = false;
let hasUserInjection = false;

  // Add this helper function to check and add imports
  function ensureImports(root) {
    // Check if GQLUserPlugin import exists
    const userImports = root.find(j.ImportDeclaration, {
      source: { value: "@/plugins/hasura-user" }
    });
    
    if (!hasUserImport && userImports.length === 0) {
      const userImport = "import { type GQLUserPlugin } from \"@/plugins/hasura-user\";";
      
      // Find the first import or add at the beginning
      const firstImport = root.find(j.ImportDeclaration).at(0);
      if (firstImport.length > 0) {
        firstImport.insertBefore(userImport);
      } else {
        // If no imports exist, add at the very beginning
        const program = root.find(j.Program);
        if (program.length > 0) {
          program.get('body', 0).insertBefore(userImport);
        }
      }
      hasUserImport = true;
    }

    // Check if inject is imported from 'vue'
    const vueImports = root.find(j.ImportDeclaration, {
      source: { value: "vue" }
    });
    
    let hasInject = false;
    if (vueImports.length > 0) {
      vueImports.forEach(path => {
        const specifiers = path.value.specifiers;
        hasInject = specifiers.some(spec => 
          spec.type === 'ImportSpecifier' && spec.imported.name === 'inject'
        );
      });
    }

    if (!hasInjectImport && !hasInject) {
      if (vueImports.length > 0) {
        // Add inject to existing vue import
        vueImports.forEach(path => {
          const specifiers = path.value.specifiers;
          specifiers.push(j.importSpecifier(j.identifier('inject')));
        });
      } else {
        // Create new vue import with inject
        const injectImport = j.importDeclaration(
          [j.importSpecifier(j.identifier('inject'))],
          j.literal("vue")
        );
        
        // Add the import
        const firstImport = root.find(j.ImportDeclaration).at(0);
        if (firstImport.length > 0) {
          firstImport.insertBefore(injectImport);
        } else {
          const program = root.find(j.Program);
          if (program.length > 0) {
            program.get('body', 0).insertBefore(injectImport);
          }
        }
      }
      hasInjectImport = true;
    }
  }
  function ensureUserInjection() {
    if (!hasUserInjection) {
      const userInjection = "const user = inject<GQLUserPlugin>(\"$user\");";
      const lastImport = root.find(j.ImportDeclaration).at(-1)
      lastImport.insertAfter(userInjection);
      hasUserInjection = true;
    }
  }
  function printWarning(message) {
    console.log(`WARN: ${message} in ${filename}`);
  }

  // Find the ExportDefaultDeclaration node
  const exportDefaultDeclaration = root.find(j.ExportDefaultDeclaration);

  // Skip the file if it doesn't have export default
  if (!exportDefaultDeclaration.length) {
    return;
  }

  // Get the object or function expression from ExportDefaultDeclaration
  let defaultObject = exportDefaultDeclaration.get('declaration').value;

  // Extract the object if export is a function call (e.g. defineComponent)
  if (defaultObject.type === 'CallExpression') {
    defaultObject = defaultObject.arguments[0];
  }

  // Remember prop and computed names to use for replacing "this" expressions
  let propNames = [];
  let dataNames = [];
  let computedNames = [];

  // Transform function for each option property

  const transformData = (property) => {
    if (property.value.type === 'ObjectExpression') {
      // Handle data as object literal: data: { count: 0, name: 'test' }
      dataNames = property.value.properties.map((prop) => prop.key.name);
      
      const dataDeclarations = property.value.properties.map((dataProperty) => {
        if (!dataProperty.key) return;

        const key = dataProperty.key.name || dataProperty.key.value;
        const value = dataProperty.value;
        const refExpression = j.callExpression(j.identifier('ref'), [value]);

        return j(
          j.variableDeclaration('const', [
            j.variableDeclarator(j.identifier(key), refExpression),
          ])
        ).toSource();
      });

      return dataDeclarations.join('\n');
    } else if (property.value.type === 'FunctionExpression' || property.value.type === 'ArrowFunctionExpression') {
      // Handle data as function: data() { return { count: 0, name: 'test' } }
      const returnStatement = j(property.value)
        .find(j.ReturnStatement)
        .at(0); // Get the first return statement in the data function

      if (returnStatement.length && returnStatement.get().value.argument.type === 'ObjectExpression') {
        const returnObject = returnStatement.get().value.argument;
        dataNames = returnObject.properties.map((prop) => prop.key.name);

        const dataDeclarations = returnObject.properties.map((dataProperty) => {
          if (!dataProperty.key) {
            return;
          }

          const key = dataProperty.key.name || dataProperty.key.value;
          const value = dataProperty.value;
          const refExpression = j.callExpression(j.identifier('ref'), [value]);

          return j(
            j.variableDeclaration('const', [
              j.variableDeclarator(j.identifier(key), refExpression),
            ])
          ).toSource();
        });

        return dataDeclarations.join('\n');
      } else {
        printWarning('Data function does not return an object literal');
        return '';
      }
    } else {
      printWarning(`Unsupported data type: ${property.value.type}`);
      return '';
    }
  };

  const transformProps = (property) => {
    // Remember the prop names
    propNames = property.value.properties.map((property) => property.key.name);

    return `const props = defineProps(${j(property.value).toSource()})`;
  };

  const transformEmits = (property) =>
    `const emit = defineEmits(${j(property.value).toSource()})`;

  const transformSetup = (property) => {
    const returnStatement = j(property)
      .find(j.ReturnStatement)
      .filter((path) => {
        return (
          path.parentPath.parentPath.parentPath.parentPath.value.key?.name ===
          'setup'
        );
      });
    const returnObjectExpression = returnStatement.find(j.ObjectExpression);

    // Remove the setup return statement
    returnStatement.remove();

    let setupBodySource = j(property.value.body.body).toSource();

    if (returnObjectExpression.length) {
      const objectNode = returnObjectExpression.get().node;

      // Iterate over the properties of the object
      const returnVariableDeclarations = objectNode.properties.map(
        (property) => {
          if (property.type === 'Property') {
            const key = property.key.name;

            if (
              property.value.type === 'Identifier' &&
              property.value.loc === null
            ) {
              return;
            }

            return j(
              j.variableDeclaration('const', [
                j.variableDeclarator(j.identifier(key), property.value),
              ])
            ).toSource();
          }

          printWarning(
            `Can't transform "${property.type}" in the return of setup function`
          );

          return '';
        }
      );

      setupBodySource = [
        ...(typeof setupBodySource === 'string'
          ? [setupBodySource]
          : setupBodySource),
        ...returnVariableDeclarations,
      ];
    }

    return setupBodySource;
  };

  const transformComputed = (property) => {
    // Remember the computed names
    computedNames = property.value.properties.map(
      (property) => property.key.name
    );

    // Iterate over properties of the nested object
    const computedDeclarations = property.value.properties.map(
      (nestedProperty) => {
        // Modify the value of each nested property
        if (!nestedProperty.key) {
          return;
        }

        const key = nestedProperty.key.name || nestedProperty.key.value;
        const value = nestedProperty.value;
        if (!value?.params || !value.body) {
          console.log(`WARN: No value for computed property "${key}", ${value}`);
          return;
        }
        
        const computedExpression = j.callExpression(j.identifier('computed'), [
          j.arrowFunctionExpression(
            value.params,
            value.body,
            value.async,
            value.generator
          ),
        ]);

        return j(
          j.variableDeclaration('const', [
            j.variableDeclarator(j.identifier(key), computedExpression),
          ])
        ).toSource();
      }
    );

    return computedDeclarations.join('\n');
  };

  const transformMethods = (property) => {
    const methodDeclarations = property.value.properties.map(
      (nestedProperty) => {
        // Modify the value of each nested property
        if (!nestedProperty.key) {
          return;
        }

        const key = nestedProperty.key.name || nestedProperty.key.value;
        const value = nestedProperty.value;

        try {
          // Create a temporary AST for the method to transform this expressions
          const methodAST = j(j.functionExpression(null, value.params, value.body, value.generator, value.async));
          
          // Find and replace this expressions within this method
          const thisExpressions = methodAST.find(j.MemberExpression, {
            object: {
              type: 'ThisExpression',
            },
            property: {
              type: 'Identifier',
            },
          });

          thisExpressions.replaceWith((path) => {
            if (!path.value.property) {
              return path.node;
            }

            const propertyName = path.value.property.name;

            // Skip special properties - they're handled globally
            if (propertyName.startsWith('$')) {
              return path.node; // Keep as-is, will be handled by global transformation
            }

            if (propNames.includes(propertyName)) {
              return j.memberExpression(
                j.identifier('props'),
                j.identifier(propertyName)
              );
            }

            if (computedNames.includes(propertyName)) {
              return j.memberExpression(
                j.identifier(propertyName),
                j.identifier('value')
              );
            }

            if (dataNames.includes(propertyName)) {
              return j.memberExpression(
                j.identifier(propertyName),
                j.identifier('value')
              );
            }

            // Check if this is a method call (this.methodName())
            if (path.parent.value.type === 'CallExpression' && 
                path.parent.value.callee === path.value) {
              // Get method names from the methods object
              const methodNames = property.value.properties.map(prop => prop.key.name);
              if (methodNames.includes(propertyName)) {
                return j.identifier(propertyName);
              }
            }

            printWarning(`Can't replace "this.${propertyName}" expression in method "${key}"`);
            return path.node;
          });

          // Get the transformed body - check if function expression exists first
          const functionExpressions = methodAST.find(j.FunctionExpression);
          let transformedBody = value.body;
          
          if (functionExpressions.length > 0) {
            transformedBody = functionExpressions.get('body').value;
          }

          const result = j(
            j.variableDeclaration('const', [
              j.variableDeclarator(
                j.identifier(key),
                j.arrowFunctionExpression(
                  value.params,
                  transformedBody,
                  value.async,
                  false // Arrow functions can't be generators
                )
              ),
            ])
          ).toSource();

          console.log(`Successfully transformed method "${key}"`);
          return result;

        } catch (error) {
          console.log(`ERROR transforming method "${key}" in ${filename}:`);
          console.log(`Original method code:`);
          console.log(j(value).toSource());
          console.log(`Error: ${error.message}`);
          console.log(`Stack: ${error.stack}`);
          
          // Return a fallback transformation without this replacement
          return j(
            j.variableDeclaration('const', [
              j.variableDeclarator(
                j.identifier(key),
                j.arrowFunctionExpression(
                  value.params,
                  value.body,
                  value.async,
                  false
                )
              ),
            ])
          ).toSource();
        }
      }
    );

  return methodDeclarations.join('\n');
};

  const transformLifeCycleMethods = (property) => {
    const methodBodyString = j(property.value).toSource();
    return `${LIFECYCLE_METHODS[property.key.name]}(${methodBodyString})`;
  };

  const transformFunctions = {
    data: transformData,
    props: transformProps,
    emits: transformEmits,
    setup: transformSetup,
    computed: transformComputed,
    methods: transformMethods,
  };

  const transformOutputs = {};

  defaultObject.properties.forEach((property) => {
    const key = property.key.name;

    if (IGNORED_OPTIONS.includes(key)) {
      return;
    }

    if (key in LIFECYCLE_METHODS) {
      transformOutputs[key] = transformLifeCycleMethods(property);
      return;
    }

    if (key in transformFunctions) {
      transformOutputs[key] = transformFunctions[key](property);
      return;
    }

    printWarning(`ignoring "${key}" option`);
  });

  // Insert the transformations at the end of the script body
  OPTIONS_ORDER.forEach((key) => {
    if (transformOutputs[key]) {
      exportDefaultDeclaration.insertBefore(transformOutputs[key]);
    }
  });

  Object.keys(LIFECYCLE_METHODS).forEach((key) => {
    if (transformOutputs[key]) {
      exportDefaultDeclaration.insertBefore(transformOutputs[key]);
    }
  });

  // Remove the export default declaration
  root.find(j.ExportDefaultDeclaration).remove();

  // Parse the transformed code
  try {
    const source = root.toSource();
    root = j(source);
  } catch (e) {
    console.log(`ERROR parsing transformed code in ${filename}:`);
    console.log(`Error: ${e.message}`);
    console.log(`Transformed code that failed to parse:`);
    console.log('='.repeat(80));
    console.log('='.repeat(80));
    return root; // Return original source instead of undefined
  }

  const specialThisExpressions = root.find(j.MemberExpression, {
    object: {
      type: 'ThisExpression',
    },
    property: {
      type: 'Identifier',
    },
  });

  specialThisExpressions.replaceWith((path) => {
    if (!path.value.property) {
      return path.node;
    }

      const propertyName = path.value.property.name;

      // Handle special Vue instance properties first
      if (propertyName === '$user') {
        // Ensure imports and injection are added
        ensureImports(root);
        ensureUserInjection();
        // Replace this.$user with user
        return 'user';
      }

      if (propertyName === '$apollo') {
        console.log(`Found this.$apollo usage - transformation pending`);
        return path.node; // Keep as-is for now
      }

      if (propertyName === '$usher') {
        console.log(`Found this.$usher usage - transformation pending`);
        return path.node; // Keep as-is for now
      }

      // Handle regular Vue component properties
      if (propNames.includes(propertyName)) {
        return j.memberExpression(
          j.identifier('props'),
          j.identifier(propertyName)
        );
      }

      if (computedNames.includes(propertyName)) {
        return j.memberExpression(
          j.identifier(propertyName),
          j.identifier('value')
        );
      }

      if (dataNames.includes(propertyName)) {
        return j.memberExpression(
          j.identifier(propertyName),
          j.identifier('value')
        );
      }

      // Check if this is a method call
      if (path.parent.value.type === 'CallExpression' && 
          path.parent.value.callee === path.value) {
        // Get all method names from the original object
        const allMethodNames = [];
        if (defaultObject.properties) {
          const methodsProperty = defaultObject.properties.find(prop => prop.key.name === 'methods');
          if (methodsProperty && methodsProperty.value.properties) {
            allMethodNames.push(...methodsProperty.value.properties.map(prop => prop.key.name));
          }
        }
        
        if (allMethodNames.includes(propertyName)) {
          return j.identifier(propertyName);
        }
      }

      printWarning(`Can't replace "this.${propertyName}" expression`);
      return path.node;
  });


  const propsUsages = root
    .find(j.Identifier, { name: 'props' })
    .filter((path) => {
      return !path.parentPath.value.type.startsWith('VariableDeclarator');
    });

  // Remove props assignment if there is no usage
  if (!propsUsages.length) {
    root.findVariableDeclarators('props').forEach((path) => {
      const definePropsCall = j.callExpression(j.identifier('defineProps'), [
        path.value.init.arguments[0],
      ]);

      // Replace the variable declaration with the defineProps call
      j(path.parent).replaceWith(j(definePropsCall).toSource());
    });
  }

  const emitUsages = root
    .find(j.Identifier, { name: 'emit' })
    .filter((path) => {
      return !path.parentPath.value.type.startsWith('VariableDeclarator');
    });

  // Remove emit assignment if there is no usage
  if (!emitUsages.length) {
    root.findVariableDeclarators('emit').forEach((path) => {
      const defineEmitsCall = j.callExpression(j.identifier('defineEmits'), [
        path.value.init.arguments[0],
      ]);

      // Replace the variable declaration with the defineEmits call
      j(path.parent).replaceWith(j(defineEmitsCall).toSource());
    });
  }

  // Use the transform function to format the code
  const transformedCode = root.toSource();

  return transformedCode;
};
