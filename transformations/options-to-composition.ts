import { ASTTransformation } from "src/wrapAstTransformation";
import wrap from '../src/wrapAstTransformation';
import { transformApollo } from "./modules/transformApollo";
import { transformWatch } from "./modules/transformWatch";
import { ensureVueImports } from "./modules/ensureVueImports";
import { FunctionExpression, ObjectMethod, ObjectProperty } from "jscodeshift";

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

export const transformAST: ASTTransformation = (context) => {
    /** @type {JSCodeShift} */
    let { j, root, filename } = context

    let hasUserInjection = false;
    function replaceThisExpressions(fnAst: any, ctx: any) {
        return fnAst.find(j.MemberExpression, {
            object: { type: 'ThisExpression' }
        }).replaceWith((path: any) => {
            const prop = path.value.property.name;
            if (prop === '$user') return j.identifier('user');
            if (ctx.propNames.includes(prop)) return j.memberExpression(j.identifier('props'), j.identifier(prop));
            if (ctx.dataNames.includes(prop)) return j.memberExpression(j.identifier(prop), j.identifier('value'));
            if (ctx.computedNames.includes(prop)) return j.memberExpression(j.identifier(prop), j.identifier('value'));
            return path.node;
        });
    }
    function ensureToasterImport() {
        const toasterInjection = 'const toaster = inject<Toaster>("toaster")';
        const toasterImports = root.find(j.Identifier, { init: "toaster" });
        if (!toasterImports.length) {
            const lastImport = root.find(j.ImportDeclaration).at(-1);
            lastImport.insertAfter(toasterInjection);
        }
    }
    function ensureUserInjection() {
        if (!hasUserInjection) {
            const userInjection = "const user = inject<GQLUserPlugin>(\"$user\");";
            const lastImport = root.find(j.ImportDeclaration).at(-1);
            lastImport.insertAfter(userInjection);
            hasUserInjection = true;
        }
    }

    function printWarning(message: string) {
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
    let propNames: string[] = [];
    let dataNames: string[] = [];
    let computedNames: string[] = [];

    const transformData = (property: any) => {
        if (property.value.type === 'ObjectExpression') {
            // Handle data as object literal: data: { count: 0, name: 'test' }
            dataNames = property.value.properties.map((prop: any) => prop.key.name);
            const dataDeclarations = property.value.properties.map((dataProperty: any) => {
                if (!dataProperty.key)
                    return;
                const key = dataProperty.key.name || dataProperty.key.value;
                const value = dataProperty.value;
                const refExpression = j.callExpression(j.identifier('ref'), [value]);
                return j(j.variableDeclaration('const', [
                    j.variableDeclarator(j.identifier(key), refExpression),
                ])).toSource();
            });
            return dataDeclarations.join('\n');
        }
        else if (property.value.type === 'FunctionExpression' || property.value.type === 'ArrowFunctionExpression') {
            // Handle data as function: data() { return { count: 0, name: 'test' } }
            const returnStatement = j(property.value)
                .find(j.ReturnStatement)
                .at(0); // Get the first return statement in the data function
            if (returnStatement.length && returnStatement.get().value.argument.type === 'ObjectExpression') {
                const returnObject = returnStatement.get().value.argument;
                dataNames = returnObject.properties.map((prop: any) => prop.key.name);
                const dataDeclarations = returnObject.properties.map((dataProperty: any) => {
                    if (!dataProperty.key) {
                        return;
                    }
                    const key = dataProperty.key.name || dataProperty.key.value;
                    const value = dataProperty.value;
                    const refExpression = j.callExpression(j.identifier('ref'), [value]);
                    return j(j.variableDeclaration('const', [
                        j.variableDeclarator(j.identifier(key), refExpression),
                    ])).toSource();
                });
                return dataDeclarations.join('\n');
            }
            else {
                printWarning('Data function does not return an object literal');
                return '';
            }
        }
        else {
            printWarning(`Unsupported data type: ${property.value.type}`);
            return '';
        }
    };
    const transformProps = (property: any) => {
        // Remember the prop names
        propNames = property.value.properties.map((property: any) => property.key.name);
        return `const props = defineProps(${j(property.value).toSource()})`;
    };
    const transformEmits = (property: ObjectMethod | ObjectProperty) => {
        const value = property.type === "ObjectMethod"
            ? property.body.body.find((n) => n.type === "ReturnStatement")!.argument.elements.map((el) => el.value).join(", ")
            : property.value;
        return `const emit = defineEmits([${value}])`;
    };
    const transformSetup = (property: any) => {
        const returnStatement = j(property)
            .find(j.ReturnStatement)
            .filter((path: any) => {
                var _a;
                return (((_a = path.parentPath.parentPath.parentPath.parentPath.value.key) === null || _a === void 0 ? void 0 : _a.name) ===
                    'setup');
            });
        const returnObjectExpression = returnStatement.find(j.ObjectExpression);
        // Remove the setup return statement
        returnStatement.remove();
        let setupBodySource = j(property.value.body.body).toSource();
        if (returnObjectExpression.length) {
            const objectNode = returnObjectExpression.get().node;
            // Iterate over the properties of the object
            const returnVariableDeclarations = objectNode.properties.map((property: any) => {
                if (property.type === 'Property') {
                    const key = property.key.name;
                    if (property.value.type === 'Identifier' &&
                        property.value.loc === null) {
                        return;
                    }
                    return j(j.variableDeclaration('const', [
                        j.variableDeclarator(j.identifier(key), property.value),
                    ])).toSource();
                }
                printWarning(`Can't transform "${property.type}" in the return of setup function`);
                return '';
            });
            setupBodySource = [
                ...(typeof setupBodySource === 'string'
                    ? [setupBodySource]
                    : setupBodySource),
                ...returnVariableDeclarations,
            ];
        }
        return setupBodySource;
    };
    const transformComputed = (property: any) => {
        computedNames = property.value.properties.map((p: any) => p.key.name);
        return property.value.properties.map((nestedProperty: any) => {
            const key = nestedProperty.key.name;
            const value = nestedProperty.value;
            if (!value?.params || !value.body) return;
            const fnAst = j(j.arrowFunctionExpression(value.params, value.body));

            replaceThisExpressions(fnAst, {
                propNames, dataNames, computedNames,
            });

            const newBody = fnAst.get().value.body;

            const computedCall = j.callExpression(j.identifier('computed'), [
                j.arrowFunctionExpression(value.params, newBody),
            ]);

            return j.variableDeclaration('const', [
                j.variableDeclarator(j.identifier(key), computedCall),
            ]);
        }).filter(Boolean);
    };

    const transformMethods = (property: any) => {
        return property.value.properties.map((nestedProperty: any) => {
            // Modify the value of each nested property
            if (!nestedProperty.key) return;
            const key = nestedProperty.key.name || nestedProperty.key.value;
            const value = nestedProperty.value;

            try {
                // Create a temporary AST for the method to transform this expressions
                const tempFunction = j.functionExpression(null, value.params, value.body, value.generator, value.async);
                const methodAST = j(tempFunction);

                // Find and replace this expressions within this method
                replaceThisExpressions(methodAST, {
                    propNames, dataNames, computedNames,
                });

                // Get the transformed body directly from the root function we created
                // Don't search for function expressions as that might find nested ones
                const funcNode = methodAST.get().node as FunctionExpression;
                const transformedBody = funcNode.body;

                const result = j.variableDeclaration('const', [
                    j.variableDeclarator(
                        j.identifier(key),
                        j.arrowFunctionExpression(
                            value.params,
                            transformedBody,
                            value.async
                        )
                    )
                ]);

                return result;
            }
            catch (error) {
                console.log(`ERROR transforming method "${key}" in ${filename}:`);
                console.log(`Original method code:`);
                console.log(j(value).toSource());
                console.log(`Error: ${error.message}`);
                console.log(`Stack: ${error.stack}`);

                // Return the original method with minimal transformation
                // Don't try to replace 'this' expressions if it's failing
                return j.variableDeclaration('const', [
                    j.variableDeclarator(
                        j.identifier(key),
                        j.arrowFunctionExpression(
                            value.params,
                            value.body,
                            value.async
                        )
                    )
                ]);
            }
        }).filter(Boolean);
    };
    const transformLifeCycleMethods = (property: any) => {
        const methodBodyString = j(property.value).toSource();
        return `${LIFECYCLE_METHODS[property.key.name as keyof typeof LIFECYCLE_METHODS]}(${methodBodyString})`;
    };

    const importEnsureFunctions = {
        // data:
        // computed:
        // watch:
    };
    const transformFunctions = {
        props: transformProps,
        setup: transformSetup,
        data: transformData,
        apollo: transformApollo,
        watch: transformWatch,
        methods: transformMethods,
        computed: transformComputed,
        emits: transformEmits,
    };
    ensureVueImports(j, root);
    const thisDollarExpressions = root.find(j.Expression, {
        object: {
            type: 'ThisExpression',
        },
        property: {
            type: 'Identifier',
            name: (name: string) => name.startsWith('$'),
        }
    });

    thisDollarExpressions.replaceWith((path: any) => {
        if (!('property' in path.value) || !path.value.property) {
            return path.node;
        }
        const propertyName = path.value.property.name;

        // Handle special Vue instance properties first
        if (propertyName === '$user') {
            // Ensure imports and injection are added
            ensureUserInjection();
            // Replace this.$user with user
            return 'user';
        }

        if (propertyName === "$root") {
            const parentCall = path.parentPath;
            if (
                parentCall.value.type === "MemberExpression" &&
                parentCall.value.property.name === "$emit" &&
                parentCall.parentPath.value.type === "CallExpression"
            ) {
                const callExpr = parentCall.parentPath.value;
                const args = callExpr.arguments;

                if (
                    args.length >= 2 &&
                    args[0].type === "Literal"
                ) {
                    const messageArg = args[1];
                    const level = args[2]?.value || "success";
                    const method = level === "error" || args[0].value === "toast_error"
                        ? "error" : "info";

                    parentCall.parentPath.replace(
                        j.callExpression(
                            j.memberExpression(j.identifier("toaster"), j.identifier(method)),
                            [messageArg]
                        )
                    );
                }
            }
            ensureToasterImport();
            return;
        }
        if (propertyName === '$apollo') {
            printWarning("this.$apollo call is preserved")
            return path.node;
        }
        if (propertyName === '$usher') {
            console.log(`Found this.$usher call is preserved`);
            return path.node;
        }
        if (propertyName === '$emit') return 'emit';

        printWarning(`Can't replace "this.${propertyName}" expression`);
        return path.node;
    });
    const transformOutputs = {};
    defaultObject.properties.forEach((property: any) => {
        const key = property.key.name;
        if (IGNORED_OPTIONS.includes(key))
            return;
        if (key in LIFECYCLE_METHODS) {
            transformOutputs[key] = transformLifeCycleMethods(property);
            return;
        }
        if (key in transformFunctions) {
            if (key in importEnsureFunctions) importEnsureFunctions[key]();
            transformOutputs[key] = transformFunctions[key](property, j);
            return;
        }
        printWarning(`ignoring "${key}" option`);
    });
    Object.keys(transformOutputs).forEach((key) => {
        const output = transformOutputs[key];
        if (!output) return;
        if (Array.isArray(output)) output.forEach(decl => exportDefaultDeclaration.insertBefore(decl));
        else exportDefaultDeclaration.insertBefore(output);
    });

    // Remove the export default declaration
    root.find(j.ExportDefaultDeclaration).remove();

    // handle this expressions
    const specialThisExpressions = root.find(j.Expression, {
        object: {
            type: 'ThisExpression',
        },
    });

    specialThisExpressions.replaceWith((path: any) => {
        if (!('property' in path.value) || !path.value.property) {
            return path.node;
        }
        const propertyName = path.value.property.name;

        // Handle regular Vue component properties
        if (propNames.includes(propertyName)) {
            return j.memberExpression(j.identifier('props'), j.identifier(propertyName));
        }
        if (computedNames.includes(propertyName)) {
            return j.memberExpression(j.identifier(propertyName), j.identifier('value'));
        }
        if (dataNames.includes(propertyName)) {
            return j.memberExpression(j.identifier(propertyName), j.identifier('value'));
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
        .find(j.Identifier, { name: '$emit' })
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

export default wrap(transformAST);
