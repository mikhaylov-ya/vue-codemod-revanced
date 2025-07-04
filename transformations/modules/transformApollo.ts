export function transformApollo(property, j) {
        const toReturn = [];
        const apolloFields = property.value.properties;
        apolloFields.forEach((field) => {
            const queryKey = field.key.name || field.key.value;
            const config = field.value;
            if (config.type !== 'ObjectExpression') {
                console.warn("config is not an object", config)
                return;
            }   

            // Extract relevant sub-properties
            const queryConfig = {};
            config.properties.forEach(prop => {
                const key = prop.key.name || prop.key.value;
                queryConfig[key] = prop.value;
            });

            if (!queryConfig.query || queryConfig.query.callee?.name !== 'require') {
                console.warn("Query not found:", queryConfig)
                return;
            }

            // Step 1: Extract .gql path and build gql tag
            const gqlId = j.identifier(`${queryKey}_gql`);
            const gqlPath = queryConfig.query.arguments[0].value;
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

            // Step 2: Extract variable names from variables() { return { ... } }
            const variablesFn = queryConfig.variables;
            const varProps = variablesFn?.body?.body?.[0]?.argument?.properties || [];
            const variablesObjectProps = varProps.map(p =>
                j.property('init', p.key, p.value)
            );

            // Step 3: transfer options!
            // 3.1 Derive `enabled` from `skip()`
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
            // 3.2 add fetchPolicy
            if (queryConfig.fetchPolicy) {
              optionsProps.push(
                j.property('init', j.identifier('fetchPolicy'), queryConfig.fetchPolicy)
              );
            }

            // Step 4: useQuery declaration
            // 4.1: transforming update() handler
            const updateFn = queryConfig.update;
            if (updateFn?.type === 'FunctionExpression') {
                const arrowUpdateFn = j.arrowFunctionExpression( updateFn.params, updateFn.body, false);
                optionsProps.push(j.property('init', j.identifier('transformResult'), arrowUpdateFn));
            }


            
            const queryVarId = j.identifier(`q_${queryKey}`);
            const useQueryDecl = j.variableDeclaration('const', [
                j.variableDeclarator(
                    queryVarId,
                    j.callExpression(j.identifier('useQuery'), [
                    gqlId,
                    j.objectExpression(variablesObjectProps),
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
