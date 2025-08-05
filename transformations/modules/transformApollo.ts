import { ASTNode, ObjectExpression, Property as PropertyType } from "jscodeshift";

export function transformApollo(property: PropertyType, j: any) {
    const toReturn: ASTNode[] = [];
    if (!("properties" in property.value)) {
        console.warn("property is not an object", property)
        return;
    }
    const apolloFields = property.value.properties;
    apolloFields.forEach((field: any) => {
        const queryKey = (field.key.name || field.key.value) as string;
        const config = field.value as ObjectExpression;
        if (config.type !== 'ObjectExpression') {
            console.warn("config is not an object", config)
            return;
        }

        // Extract relevant sub-properties
        const queryConfig = config.properties.reduce((acc: any, prop: any) => {
            const key = prop.key.name || prop.key.value;
            return { ...acc, [key]: prop.value }
        }, {});

        if (!queryConfig.query || queryConfig.query.callee?.name !== 'require') {
            console.warn("Query not found:", queryConfig)
            return;
        }

        // Step 1: Extract .gql path and build gql tag
        const gqlId = j.identifier(`${queryKey}_gql`);

        const gqlPath = queryConfig.query.source?.value ?? queryConfig.query.arguments[0].value;
        const gqlConst = j.variableDeclaration('const', [
            j.variableDeclarator(
                gqlId,
                j.callExpression(
                    j.identifier('gql'),
                    [j.templateLiteral([j.templateElement({ raw: gqlPath, cooked: gqlPath }, true)], [])]
                )
            )
        ]);
        toReturn.unshift(j(gqlConst).toSource());

        // Step 2: Extract variable names from variables() { return { ... } } or variables: { ... }
        const queryVariables = queryConfig.variables;
        let variablesObjectProps = [];

        if (queryVariables?.type === 'FunctionExpression') {
            // Handle function-type variables: variables() { return { ... } }
            const returnStatement = queryVariables?.body?.body?.[0];
            if (returnStatement?.type === 'ReturnStatement') {
                if (returnStatement.argument?.type === 'ObjectExpression') {
                    // Return statement returns an object: return { ... }
                    const varProps = returnStatement.argument.properties || [];
                    variablesObjectProps = varProps.map((p: any) => {
                        if (p.type === 'SpreadElement') {
                            return j.spreadElement(p.argument);
                        }
                        return j.property('init', p.key, p.value)
                    });
                } else {
                    // Return statement returns a function call or expression: return this.method()
                    // We'll wrap it in a computed function that calls the original function
                    variablesObjectProps = [];
                    const originalFunction = j.arrowFunctionExpression(
                        queryVariables.params,
                        queryVariables.body,
                        false
                    );
                    const variablesComputedId = j.identifier(`${queryKey}_variables`);
                    const variablesComputedDecl = j.variableDeclaration('const', [
                        j.variableDeclarator(
                            variablesComputedId,
                            j.callExpression(j.identifier('computed'), [originalFunction])
                        )
                    ]);
                    toReturn.push(j(variablesComputedDecl).toSource());

                    // Skip the rest of the processing since we've already created the computed
                    const queryVarId = j.identifier(`${queryKey}_query`);
                    const useQueryDecl = j.variableDeclaration('const', [
                        j.variableDeclarator(
                            queryVarId,
                            j.callExpression(j.identifier('useQuery'), [
                                gqlId,
                                variablesComputedId,
                                j.objectExpression([])
                            ])
                        )
                    ]);
                    toReturn.push(j(useQueryDecl).toSource());
                    return;
                }
            }
        } else if (queryVariables?.type === 'ObjectExpression') {
            // Handle object-type variables: variables: { ... }
            variablesObjectProps = queryVariables.properties.map((p: any) => {
                if (p.type === 'SpreadElement') {
                    return j.spreadElement(p.argument);
                }
                return j.property('init', p.key, p.value)
            });
        }

        // Step 3: Create computed variables object
        const variablesComputedId = j.identifier(`${queryKey}_variables`);
        const variablesComputedDecl = j.variableDeclaration('const', [
            j.variableDeclarator(
                variablesComputedId,
                j.callExpression(j.identifier('computed'), [
                    j.arrowFunctionExpression([], j.objectExpression(variablesObjectProps))
                ])
            )
        ]);
        toReturn.push(j(variablesComputedDecl).toSource());

        // Step 4: transfer options!
        // 4.1 Derive `enabled` from `skip()`
        const optionsProps = [];
        const skipFn = queryConfig.skip;
        if (skipFn?.type === 'FunctionExpression') {
            const arrowSkipFn = j.arrowFunctionExpression(
                skipFn.params,
                skipFn.body,
                false
            );

            optionsProps.push(
                j.property('init', j.identifier('skip'), arrowSkipFn)
            );
        } else {
            optionsProps.push(
                j.property('init', j.identifier('enabled'), j.literal(true))
            );
        }
        // 4.2 add fetchPolicy
        if (queryConfig.fetchPolicy) {
            optionsProps.push(
                j.property('init', j.identifier('fetchPolicy'), queryConfig.fetchPolicy)
            );
        }

        // Step 5: useQuery declaration
        // 5.1: transforming update() handler
        const updateFn = queryConfig.update;
        if (updateFn?.type === 'FunctionExpression') {
            const arrowUpdateFn = j.arrowFunctionExpression(updateFn.params, updateFn.body, false);
            optionsProps.push(j.property('init', j.identifier('update'), arrowUpdateFn));
        }

        const queryVarId = j.identifier(`${queryKey}_query`);

        const useQueryDecl = j.variableDeclaration('const', [
            j.variableDeclarator(
                queryVarId,
                j.callExpression(j.identifier('useQuery'), [
                    gqlId,
                    variablesComputedId,
                    j.objectExpression(optionsProps)
                ])
            )
        ]);

        // Step 5: Result() access → compute top-level field → computed()
        const resultFn = queryConfig.result;
        if (resultFn && resultFn.params.length > 0) {
            const resultParam = resultFn.params[0];
            let topDataKey = queryKey;

            // Try to detect top-level key in result({ data: { some_field } })
            if (resultParam.type === 'ObjectPattern') {
                const dataProp = resultParam.properties.find(p => p.key.name === 'data');
                if (dataProp?.value?.type === 'ObjectPattern') {
                    const firstKey = dataProp.value.properties[0]?.key?.name;
                    if (firstKey) topDataKey = firstKey;
                }
            }

            const valueAccess = j.optionalMemberExpression(
                j.memberExpression(queryVarId, j.identifier('result')),
                j.identifier('value'),
                false,
                true
            );
            const topFieldAccess = j.optionalMemberExpression(
                valueAccess,
                j.identifier(topDataKey),
                false,
                true
            );

            const computedId = j.identifier(`${topDataKey}_result`);
            const computedDecl = j.variableDeclaration('const', [
                j.variableDeclarator(
                    computedId,
                    j.callExpression(j.identifier('computed'), [
                        j.arrowFunctionExpression([], j.logicalExpression('||', topFieldAccess, j.literal(null)))
                    ])
                )
            ]);
            toReturn.push(j(computedDecl).toSource());
        }
        toReturn.push(j(useQueryDecl).toSource());
    });
    return toReturn.join('\n');
};
