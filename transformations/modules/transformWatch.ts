export function transformWatch(watchNode, j) {

  const watchCalls = [];

  // Process each property in the watch object
  watchNode.value.properties.forEach((property) => {
    const watchKey = getWatchKey(j, property.key);
    const watchValue = property.value;

    // Handle different watch value types
    if (j.ObjectExpression.check(watchValue)) {
      // Object syntax with handler, deep, immediate, etc.
      const watchCall = createWatchCallFromObject(j, watchKey, watchValue);
      if (watchCall) {
        watchCalls.push(watchCall);
      }
    } else if (j.FunctionExpression.check(watchValue) || j.ArrowFunctionExpression.check(watchValue)) {
      // Direct function syntax
      const watchCall = createWatchCallFromFunction(j, watchKey, watchValue);
      if (watchCall) {
        watchCalls.push(watchCall);
      }
    } else if (j.Identifier.check(watchValue) || j.Literal.check(watchValue)) {
      // String method name
      const watchCall = createWatchCallFromMethodName(j, watchKey, watchValue);
      if (watchCall) {
        watchCalls.push(watchCall);
      }
    }
  });

  return watchCalls;
}

/**
 * Extract the watch key from property key node
 */
function getWatchKey(j, keyNode) {
  if (j.Literal.check(keyNode)) {
    return keyNode.value;
  } else if (j.Identifier.check(keyNode)) {
    return keyNode.name;
  }
  return null;
}

/**
 * Create watch call from object expression (with handler, options)
 */
function createWatchCallFromObject(j, watchKey, objectValue) {
  let handler = null;
  const options = {};

  // Extract handler and options from object properties
  objectValue.properties.forEach(prop => {
    const propName = prop.key.name || prop.key.value;

    if (propName === 'handler') {
      handler = prop.value;
    } else if (['deep', 'immediate', 'flush'].includes(propName)) {
      options[propName] = prop.value;
    }
  });

  if (!handler) {
    return null;
  }

  // Transform the handler function
  const transformedHandler = transformWatchHandler(j, handler);

  // Create the watch expression
  const watchExpression = createWatchExpression(j, watchKey);

  // Build the watch call
  const args = [watchExpression, transformedHandler];

  // Add options as third argument if any exist
  if (Object.keys(options).length > 0) {
    const optionsObject = j.objectExpression(
      Object.entries(options).map(([key, value]) =>
        j.objectProperty(j.identifier(key), value)
      )
    );
    args.push(optionsObject);
  }

  return j.expressionStatement(
    j.callExpression(j.identifier('watch'), args)
  );
}

/**
 * Create watch call from direct function
 */
function createWatchCallFromFunction(j, watchKey, functionValue) {
  const transformedHandler = transformWatchHandler(j, functionValue);
  const watchExpression = createWatchExpression(j, watchKey);

  return j.expressionStatement(
    j.callExpression(j.identifier('watch'), [watchExpression, transformedHandler])
  );
}

/**
 * Create watch call from method name
 */
function createWatchCallFromMethodName(j, watchKey, methodValue) {
  const watchExpression = createWatchExpression(j, watchKey);

  // Convert method name to function call
  let methodCall;
  if (j.Literal.check(methodValue)) {
    methodCall = j.identifier(methodValue.value);
  } else {
    methodCall = methodValue;
  }

  return j.expressionStatement(
    j.callExpression(j.identifier('watch'), [watchExpression, methodCall])
  );
}

/**
 * Create the watch expression (first argument) - the reactive reference
 */
function createWatchExpression(j, watchKey) {
  // Handle nested property access (e.g., "edited_item.key")
  if (typeof watchKey === 'string' && watchKey.includes('.')) {
    const parts = watchKey.split('.');
    let expression = j.identifier(parts[0]);

    for (let i = 1; i < parts.length; i++) {
      expression = j.memberExpression(expression, j.identifier(parts[i]));
    }

    // Wrap in arrow function for computed watching
    return j.arrowFunctionExpression([], expression);
  } else {
    // Simple property reference
    return j.arrowFunctionExpression([], j.identifier(watchKey));
  }
}

/**
 * Transform the watch handler function to replace this. with .value
 */
function transformWatchHandler(j, handlerNode) {
  // Convert function expression to arrow function if it's not already
  let transformedHandler;
  if (j.FunctionExpression.check(handlerNode)) {
    transformedHandler = j.arrowFunctionExpression(
      handlerNode.params,
      handlerNode.body
    );
  } else {
    const handlerSource = handlerNode.params ? handlerNode : handlerNode.arguments[0];
    // For arrow functions, create a copy
    transformedHandler = j.arrowFunctionExpression(
      // If watcher callback is wrapped with another func, like lodash.debounce()
      handlerSource.params,
      handlerSource.body
    );
  }

  // Transform this. accesses within the handler
  j(transformedHandler).find(j.MemberExpression).forEach(path => {
    const node = path.node;

    // Check if it's a this. access
    if (j.ThisExpression.check(node.object)) {
      const propertyName = node.property.name || node.property.value;

      // Don't transform properties starting with $
      if (typeof propertyName === 'string' && !propertyName.startsWith('$')) {
        // Replace this.property with property.value
        const newExpression = j.memberExpression(
          j.identifier(propertyName),
          j.identifier('value')
        );
        j(path).replaceWith(newExpression);
      } else if (typeof propertyName === 'string' && propertyName.startsWith('$')) {
        // Keep $ properties as is, but remove 'this.'
        j(path).replaceWith(j.identifier(propertyName));
      }
    }
  });

  return transformedHandler;
}
