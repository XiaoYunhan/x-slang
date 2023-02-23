/* tslint:disable:max-classes-per-file */
import * as es from 'estree'
import * as constants from '../constants'
import * as errors from '../errors/errors'
import { RuntimeSourceError } from '../errors/runtimeSourceError'
import { Context, Environment, Frame, Value } from '../types'
import { primitive } from '../utils/astCreator'
import {
  evaluateBinaryExpression,
  evaluateConditionalExpression,
  evaluateUnaryExpression
} from '../utils/operators'
import * as rttc from '../utils/rttc'
import { stringify } from '../utils/stringify'
import Closure from './closure'

class BreakValue {}

class ContinueValue {}

class ReturnValue {
  constructor(public value: Value) {}
}

class TailCallReturnValue {
  constructor(public callee: Closure, public args: Value[], public node: es.CallExpression) {}
}

class Thunk {
  public value: Value
  public isMemoized: boolean
  constructor(public exp: es.Node, public env: Environment) {
    this.isMemoized = false
    this.value = null
  }
}

function* forceIt(val: any, context: Context): Value {
  if (val instanceof Thunk) {
    if (val.isMemoized) return val.value

    pushEnvironment(context, val.env)
    const evalRes = yield* actualValue(val.exp, context)
    popEnvironment(context)
    val.value = evalRes
    val.isMemoized = true
    return evalRes
  } else return val
}

export function* actualValue(exp: es.Node, context: Context): Value {
  const evalResult = yield* evaluate(exp, context)
  const forced = yield* forceIt(evalResult, context)
  return forced
}

const createEnvironment = (
  closure: Closure,
  args: Value[],
  callExpression?: es.CallExpression
): Environment => {
  const environment: Environment = {
    name: closure.functionName, // TODO: Change this
    tail: closure.environment,
    head: {}
  }
  if (callExpression) {
    environment.callExpression = {
      ...callExpression,
      arguments: args.map(primitive)
    }
  }
  closure.node.params.forEach((param, index) => {
    const ident = param as es.Identifier
    environment.head[ident.name] = args[index]
  })
  return environment
}

const createBlockEnvironment = (
  context: Context,
  name = 'blockEnvironment',
  head: Frame = {}
): Environment => {
  return {
    name,
    tail: currentEnvironment(context),
    head
  }
}

const handleRuntimeError = (context: Context, error: RuntimeSourceError): never => {
  context.errors.push(error)
  context.runtime.environments = context.runtime.environments.slice(
    -context.numberOfOuterEnvironments
  )
  throw error
}

const DECLARED_BUT_NOT_YET_ASSIGNED = Symbol('Used to implement hoisting')
const ASSIGNED_SUCCESSFUL = 'Assigned Successful'
const NOT_WRITABLE = 'Not writable'
const UNDEFINED_VARIABLE = 'Undefined variable'

function declareIdentifier(context: Context, name: string, node: es.Node) {
  const environment = currentEnvironment(context)
  if (environment.head.hasOwnProperty(name)) {
    const descriptors = Object.getOwnPropertyDescriptors(environment.head)

    return handleRuntimeError(
      context,
      new errors.VariableRedeclaration(node, name, descriptors[name].writable)
    )
  }
  environment.head[name] = DECLARED_BUT_NOT_YET_ASSIGNED
  return environment
}

function declareVariables(context: Context, node: es.VariableDeclaration) {
  for (const declaration of node.declarations) {
    declareIdentifier(context, (declaration.id as es.Identifier).name, node)
  }
}

function declareFunctionsAndVariables(context: Context, node: es.BlockStatement) {
  for (const statement of node.body) {
    declareFunctionsAndVariablesForStatement(context, statement)
  }
}

function declareFunctionsAndVariablesForStatement(context: Context, statement: es.Statement) {
  switch (statement.type) {
    case 'VariableDeclaration':
      declareVariables(context, statement)
      break
    case 'FunctionDeclaration':
      declareIdentifier(context, (statement.id as es.Identifier).name, statement)
      break
  }
}

function* processIfStatement(
  node: es.IfStatement | es.ConditionalExpression,
  context: Context
): IterableIterator<es.Node> {
  const testValue = yield* actualValue(node.test, context)
  return testValue ? node.consequent : node.alternate
}

function defineVariable(
  context: Context,
  name: string,
  value: Value,
  kind: string,
  node: es.Node,
  constant = false
) {
  const environment = context.runtime.environments[0]

  if (environment.head[name] !== DECLARED_BUT_NOT_YET_ASSIGNED) {
    return handleRuntimeError(context, new errors.UndefinedVariable(name, node))
  }

  if (kind === 'const') {
    Object.defineProperty(environment.head, name, {
      value,
      writable: constant,
      enumerable: true
    })
  } else {
    Object.defineProperty(environment.head, name, {
      value,
      writable: !constant,
      enumerable: true
    })
  }
  return environment
}

function* visit(context: Context, node: es.Node) {
  context.runtime.nodes.unshift(node)
  yield context
}

function* leave(context: Context) {
  context.runtime.nodes.shift()
  yield context
}

const currentEnvironment = (context: Context) => context.runtime.environments[0]
const replaceEnvironment = (context: Context, environment: Environment) =>
  (context.runtime.environments[0] = environment)
const popEnvironment = (context: Context) => context.runtime.environments.shift()
const pushEnvironment = (context: Context, environment: Environment) =>
  context.runtime.environments.unshift(environment)

const checkNumberOfArguments = (
  context: Context,
  callee: Closure | Value,
  args: Value[],
  exp: es.CallExpression
) => {
  if (callee instanceof Closure) {
    if (callee.node.params.length !== args.length) {
      return handleRuntimeError(
        context,
        new errors.InvalidNumberOfArguments(exp, callee.node.params.length, args.length)
      )
    }
  } else {
    if (callee.hasVarArgs === false && callee.length !== args.length) {
      return handleRuntimeError(
        context,
        new errors.InvalidNumberOfArguments(exp, callee.length, args.length)
      )
    }
  }
  return undefined
}

export type Evaluator<T extends es.Node> = (node: T, context: Context) => IterableIterator<Value>

function* evaluateBlockSatement(context: Context, node: es.BlockStatement) {
  declareFunctionsAndVariables(context, node)
  let result
  for (const statement of node.body) {
    result = yield* evaluate(statement, context)
    if (
      result instanceof ReturnValue ||
      result instanceof TailCallReturnValue ||
      result instanceof BreakValue ||
      result instanceof ContinueValue
    ) {
      break
    }
  }
  return result
}

function* evaluateSatement(context: Context, statement: es.Statement) {
  declareFunctionsAndVariablesForStatement(context, statement)
  return yield* evaluate(statement, context)
}

function* assignValue(name: string, val: any, context: Context) {
  let environment = currentEnvironment(context) as Environment | null
  while (environment !== null) {
    if (environment.head.hasOwnProperty(name)) {
      const descriptors = Object.getOwnPropertyDescriptors(environment.head)
      if (descriptors[name].writable) {
        environment.head[name] = val
        return ASSIGNED_SUCCESSFUL
      } else {
        return NOT_WRITABLE
      }
    } else {
      environment = environment.tail
    }
  }

  return UNDEFINED_VARIABLE
}
/**
 * WARNING: Do not use object literal shorthands, e.g.
 *   {
 *     *Literal(node: es.Literal, ...) {...},
 *     *ThisExpression(node: es.ThisExpression, ..._ {...},
 *     ...
 *   }
 * They do not minify well, raising uncaught syntax errors in production.
 * See: https://github.com/webpack/webpack/issues/7566
 */
// tslint:disable:object-literal-shorthand
// prettier-ignore
export const evaluators: { [nodeType: string]: Evaluator<es.Node> } = {
    /** Simple Values */
    Literal: function*(node: es.Literal, context: Context) {
        return node.value
    },

    TemplateLiteral: function*(node: es.TemplateLiteral) {
        // Expressions like `${1}` are not allowed, so no processing needed
        return node.quasis[0].value.cooked
    },

    ThisExpression: function*(node: es.ThisExpression, context: Context) {
        return context.runtime.environments[0].thisContext
    },

    ArrayExpression: function*(node: es.ArrayExpression, context: Context) {
        const array = []
        for (const element of node.elements) {
          array.push(yield* evaluate(element, context))
        }
        return array
        // throw new Error("Array expressions not supported in x-slang");
    },

    DebuggerStatement: function*(node: es.DebuggerStatement, context: Context) {
        yield
    },

    FunctionExpression: function*(node: es.FunctionExpression, context: Context) {
      return new Closure(node, currentEnvironment(context), context)
        // throw new Error("Function expressions not supported in x-slang");
    },

    ArrowFunctionExpression: function*(node: es.ArrowFunctionExpression, context: Context) {
        // throw new Error("Arrow functions expressions not supported in x-slang");
        return Closure.makeFromArrowFunction(node, currentEnvironment(context), context)
    },

    Identifier: function*(node: es.Identifier, context: Context) {
        const environment = currentEnvironment(context);
        const name = node.name
        const identifierValue = yield* propertyOfIdentifier(name, environment)
        if (identifierValue !== null) {
           if (identifierValue !== DECLARED_BUT_NOT_YET_ASSIGNED) {
             return identifierValue
           } 
        } else {
            return handleRuntimeError(
            context,
            new errors.UndefinedVariable(name, node)
          )
        }

        // throw new Error("Variables not supported in x-slang");
    },

    CallExpression: function*(node: es.CallExpression, context: Context) {
        // throw new Error("Call expressions not supported in x-slang");
        const value = yield* actualValue(node.callee, context)
        let numExpectedParam: number = node.arguments.length
        const numActualParam: number = node.arguments.length
        let paramsCopy:any
        if(value.originalNode.leadingComments !== undefined) {
          if(value instanceof Closure) {
            const comment:any = value.originalNode.leadingComments
            try{
              paramsCopy = JSON.parse(comment.value)
              numExpectedParam = Object.keys(paramsCopy).length
            } catch (e) {console.log(e)}
          }
          if(numExpectedParam > numActualParam) {
            for(let i=numActualParam; i<numExpectedParam; i++) {
              const newLiteral: es.Literal = {value: paramsCopy[i].right.value, raw: paramsCopy[i].right.raw, type: 'Literal'}
              node.arguments.push(newLiteral)
            }
          }
        }
        const args = []
        for (const arg of node.arguments) {
          args.push(yield* actualValue(arg, context))
        }
        let thisContext
        if (node.callee.type === 'MemberExpression') {
          thisContext = yield* actualValue(node.callee.object, context)
        }
        const result = yield* apply(context, value, args, node, thisContext)
        return result 
    },

  //   if (callee instanceof Closure) {
  //     obj.__proto__ = callee.fun.prototype
  //     callee.fun.apply(obj, args)
  // } else {
  //     obj.__proto__ = callee.prototype
  //     callee.apply(obj, args)
  // }
    NewExpression: function*(node: es.NewExpression, context: Context) {
        const callee = yield* evaluate(node.callee, context)
        const args = []
        for (const arg of node.arguments) {
            args.push(yield* evaluate(arg, context))
        }
        const obj: Value = {}
        obj.__proto__ = callee.prototype
        callee.apply(obj, args)
        return obj
    },

    UnaryExpression: function*(node: es.UnaryExpression, context: Context) {
        const value = yield* actualValue(node.argument, context)

        const error = rttc.checkUnaryExpression(node, node.operator, value)
        if (error) {
            return handleRuntimeError(context, error)
        }
        return evaluateUnaryExpression(node.operator, value)
    },

    BinaryExpression: function*(node: es.BinaryExpression, context: Context) {
        const left = yield* actualValue(node.left, context)
        const right = yield* actualValue(node.right, context)
        const error = rttc.checkBinaryExpression(node, node.operator, left, right)
        if (error) {
            return handleRuntimeError(context, error)
        }
        return evaluateBinaryExpression(node.operator, left, right)
    },

    ConditionalExpression: function*(node: es.ConditionalExpression, context: Context) {
        // throw new Error("Conditional expressions not supported in x-slang");
        const test = yield* actualValue(node.test, context)
        const consequent = yield* actualValue(node.consequent, context)
        const alternate = yield* actualValue(node.alternate, context)
        const error = rttc.checkIfStatement(node, test)
        if (error) {
          return handleRuntimeError(context, error)
        }
        
        return evaluateConditionalExpression(test, consequent, alternate)
    },

    LogicalExpression: function*(node: es.LogicalExpression, context: Context) {
        throw new Error("Logical expressions not supported in x-slang");
    },

    VariableDeclaration: function*(node: es.VariableDeclaration, context: Context) {
        const declaration = node.declarations[0]
        const kind = node.kind
        const id = declaration.id as es.Identifier
        if (declaration.init! === null && kind === "const") {
          return handleRuntimeError(
            context,
            new errors.ConstNotInitialize(node, id.name)
          )
        } else if (declaration.init! !== null)  {
          const value = yield* actualValue(declaration.init!, context)
          defineVariable(context, id.name, value, kind, node)
        }
        return undefined
        // throw new Error("Variable declarations not supported in x-slang");
    },

    ContinueStatement: function*(node: es.ContinueStatement, context: Context) {
        // throw new Error("Continue statements not supported in x-slang");
        return new ContinueValue()
    },

    BreakStatement: function*(node: es.BreakStatement, context: Context) {
        // throw new Error("Break statements not supported in x-slang");
        return new BreakValue()
    },

    ForStatement: function*(node: es.ForStatement, context: Context) {
        // Create a new block scope for the loop variables
        // throw new Error("For statements not supported in x-slang");
        const init = node.init as es.Statement | null
        const test = node.test as es.Expression
        const update = node.update as es.Expression
        const body = node.body as es.BlockStatement
        const forEnvironment = createBlockEnvironment(context)
        pushEnvironment(context, forEnvironment) 
        if (init !== null) {
          yield* evaluateSatement(context, init)
        }
        while(true) {     
          const testValue = yield *actualValue(test, context)
          if (testValue) {
            const blockEnviroment = createBlockEnvironment(context)
            pushEnvironment(context, blockEnviroment)
            for (const name in forEnvironment.head) {
              if (forEnvironment.head.hasOwnProperty(name)) {
                declareIdentifier(context, name, node)
                yield* assignValue(name, forEnvironment.head[name], context)
              }
            }
            const result = yield* evaluateBlockSatement(context, body)
            popEnvironment(context)
            if (result instanceof BreakValue) {
              break
            }
            if (result instanceof ReturnValue) {
              popEnvironment(context)
              return result
            }
            yield* evaluate(update, context)
            continue
          } else {
            break
          }
        }
        
        popEnvironment(context)
        return undefined
    },

    UpdateExpression: function*(node: es.UpdateExpression, context: Context) {
        const argument = node.argument as es.Identifier
        const operator = node.operator
        const name = argument.name
        const val = yield* actualValue(argument, context)
        let result
        if (operator === "++") {
          result = yield* assignValue(name, val + 1, context)
        } else if (operator === "--") {
          result = yield* assignValue(name, val - 1, context)
        }
        
        if (result === NOT_WRITABLE) {
          return handleRuntimeError(
                context,
                new errors.ConstAssignment(node, name))
        } else if (result === UNDEFINED_VARIABLE) {
            return handleRuntimeError(
                context,
                new errors.UndefinedVariable(name, node)
          )
        } else {
            return undefined
        }
        // throw new Error("For statements not supported in x-slang");
    },

    MemberExpression: function*(node: es.MemberExpression, context: Context) {
        const obj = yield* evaluate(node.object, context)
        let prop
        if (node.computed) {
          prop = yield* actualValue(node.property, context)
        } else {
          const propNode = node.property as es.Identifier
          prop = propNode.name
        }
        
        const error = rttc.checkMemberAccess(node, obj, prop);
        if (error !== undefined) {
          return handleRuntimeError(context, error);
        } 
        
        if (typeof obj === 'object' ) {
          const res = yield* lookupProp(obj, prop)
          if (res !== undefined) {
            return res
          } else {
            return handleRuntimeError(
              context,
              new errors.GetInheritedPropertyError(node, obj, stringify(prop)))
          }
        } else if (obj.hasOwnProperty(prop)) {
          return obj[prop]
        } else {
          return handleRuntimeError(
                    context,
                    new errors.GetPropertyError(node, obj, stringify(prop)))
        }
       // throw new Error("Member statements not supported in x-slang");
    },

    AssignmentExpression: function*(node: es.AssignmentExpression, context: Context) {
        const val = yield* evaluate(node.right, context)
        if (node.left.type === "MemberExpression") {
          const left = node.left
          const obj = yield* evaluate(left.object, context)
          let prop
          if (left.computed) {
            prop = yield* actualValue(left.property, context)
          } else {
            const propNode = left.property as es.Identifier
            prop = propNode.name
          }
          
          
          const error = rttc.checkMemberAccess(node, obj, prop);

          if (error !== undefined) {
            return handleRuntimeError(context, error);
          } 
    
          try {
            obj[prop] = val
          } catch {
            return handleRuntimeError(context, new errors.SetPropertyError(node, obj, stringify(prop)))
          }
          return undefined
        } else {
          const left = node.left as es.Identifier
          const name = left.name
          const result = yield* assignValue(name, val, context)
  
          if (result === NOT_WRITABLE) {
            return handleRuntimeError(
                  context,
                  new errors.ConstAssignment(node, name))
          } else if (result === UNDEFINED_VARIABLE) {
              return handleRuntimeError(
                  context,
                  new errors.UndefinedVariable(name, node)
            )
          } else {
              return undefined
          }
        }
        // throw new Error("Assignment expressions not supported in x-slang");
    },

    FunctionDeclaration: function*(node: es.FunctionDeclaration, context: Context) {
        // throw new Error("Function declarations not supported in x-slang");
        const id = node.id as es.Identifier
        const paramsCopy = Object.assign({}, node.params)
        const paramsString = JSON.stringify(paramsCopy)
        const newComment = Object.create(Comment)
        newComment.value = paramsString
        const closure = new Closure(node, currentEnvironment(context), context)
        node.leadingComments = newComment
        defineVariable(context, id.name, closure, 'constant', node, true)
        return undefined
    },

    IfStatement: function*(node: es.IfStatement | es.ConditionalExpression, context: Context) {
        const stat = yield* processIfStatement(node, context)
        let result
        if (stat !== null) {
          result = yield* evaluate(stat, context)
        } else {
          return undefined
        }
        return result
    },

    ExpressionStatement: function*(node: es.ExpressionStatement, context: Context) {
        return yield* evaluate(node.expression, context)
    },

    ReturnStatement: function*(node: es.ReturnStatement, context: Context) {
        // throw new Error("Return statements not supported in x-slang");
        const returnExpression = node.argument!
        return new ReturnValue(yield* evaluate(returnExpression, context))
    },

    WhileStatement: function*(node: es.WhileStatement, context: Context) {
        const test = node.test as es.Expression
        const body = node.body as es.BlockStatement
        const whileStatement = createBlockEnvironment(context)
        pushEnvironment(context, whileStatement)
        while(true) {
          const testValue = yield *actualValue(test, context)
          if(testValue) {
            const blockEnviroment = createBlockEnvironment(context)
            pushEnvironment(context, blockEnviroment)
            const result = yield* evaluateBlockSatement(context, body)
            popEnvironment(context)
            if(result instanceof BreakValue) {break}
            if(result instanceof ReturnValue) {
              popEnvironment(context)
              return result
            }
            continue
          }
          else {break}
        }
        popEnvironment(context)
        return undefined
    },

    ObjectExpression: function*(node: es.ObjectExpression, context: Context) {
        const properties = node.properties
        const temp = {} 
        for (let i = 0; i < properties.length; i++) {
          const prop = properties[i] as es.Property
          const key = prop.key as es.Identifier
          const keyName = key.type === "Identifier" ? key.name: yield* evaluate(key, context)
          const val = yield* evaluate(prop.value, context)
          temp[keyName] = val
        }

        return temp
        // throw new Error("Object expressions not supported in x-slang");
    },

    BlockStatement: function*(node: es.BlockStatement, context: Context) {
        const blockEnviroment = createBlockEnvironment(context)
        pushEnvironment(context, blockEnviroment)
        const result = yield* evaluateBlockSatement(context, node)
        popEnvironment(context)
        return result
        // throw new Error("Block statements not supported in x-slang");
    },

    ImportDeclaration: function*(node: es.ImportDeclaration, context: Context) {
        // throw new Error("Import declarations not supported in x-slang");
    },

    Program: function*(node: es.BlockStatement, context: Context) {
        context.numberOfOuterEnvironments += 1
        const environment = createBlockEnvironment(context, 'programEnvironment')
        pushEnvironment(context, environment)
        const result = yield* forceIt(yield* evaluateBlockSatement(context, node), context);
        return result;
    }
}
export function* lookupProp(obj: any, prop: string) {
  while (obj.__proto__ !== undefined) {
    if (obj.hasOwnProperty(prop)) {
      return obj[prop]
    } else {
      if (obj.__proto__ !== undefined) {
        obj = obj.__proto__
      } else {
        return undefined
      }
    }
  }

  return undefined
}

// tslint:enable:object-literal-shorthand
export function* propertyOfIdentifier(name: string, environment: Environment | null): any {
  while (environment !== null) {
    if (environment.head.hasOwnProperty(name)) {
      return environment.head[name]
    }

    environment = environment.tail
  }
  return null
}

export function* evaluate(node: es.Node, context: Context) {
  yield* visit(context, node)
  const result = yield* evaluators[node.type](node, context)
  yield* leave(context)
  return result
}

export function* apply(
  context: Context,
  fun: Closure | Value,
  args: (Thunk | Value)[],
  node: es.CallExpression,
  thisContext?: Value
) {
  let result: Value
  let total = 0

  while (!(result instanceof ReturnValue)) {
    if (fun instanceof Closure) {
      checkNumberOfArguments(context, fun, args, node!)
      const environment = createEnvironment(fun, args, node)
      if (result instanceof TailCallReturnValue) {
        replaceEnvironment(context, environment)
      } else {
        pushEnvironment(context, environment)
        total++
      }
      const bodyEnvironment = createBlockEnvironment(context, 'functionBodyEnvironment')
      bodyEnvironment.thisContext = thisContext
      pushEnvironment(context, bodyEnvironment)
      result = yield* evaluateBlockSatement(context, fun.node.body as es.BlockStatement)
      popEnvironment(context)
      if (result instanceof TailCallReturnValue) {
        fun = result.callee
        node = result.node
        args = result.args
      } else if (!(result instanceof ReturnValue)) {
        // No Return Value, set it as undefined
        result = new ReturnValue(undefined)
      }
    } else if (typeof fun === 'function') {
      checkNumberOfArguments(context, fun, args, node!)
      try {
        const forcedArgs = []

        for (const arg of args) {
          forcedArgs.push(yield* forceIt(arg, context))
        }

        result = fun.apply(thisContext, forcedArgs)
        break
      } catch (e) {
        // Recover from exception
        context.runtime.environments = context.runtime.environments.slice(
          -context.numberOfOuterEnvironments
        )

        const loc = node ? node.loc! : constants.UNKNOWN_LOCATION
        if (!(e instanceof RuntimeSourceError || e instanceof errors.ExceptionError)) {
          // The error could've arisen when the builtin called a source function which errored.
          // If the cause was a source error, we don't want to include the error.
          // However if the error came from the builtin itself, we need to handle it.
          return handleRuntimeError(context, new errors.ExceptionError(e, loc))
        }
        result = undefined
        throw e
      }
    } else {
      return handleRuntimeError(context, new errors.CallingNonFunctionValue(fun, node))
    }
  }
  // Unwraps return value and release stack environment
  if (result instanceof ReturnValue) {
    result = result.value
  }
  for (let i = 1; i <= total; i++) {
    popEnvironment(context)
  }
  return result
}
