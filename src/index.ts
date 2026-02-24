import type { AtRule, ChildNode, Declaration, PluginCreator, Rule } from 'postcss';
import type { CSSObjectInput, DynamicRule, Preflight, Preset, Variant } from 'unocss';
import Nesting from '@tailwindcss/nesting';
import daisyui from 'daisyui';
// import { createPlugin } from '@unocss/postcss/esm';
import postcss from 'postcss';
import Stringifier from 'postcss/lib/stringifier';
import { symbols } from 'unocss';
import parse from './parser.js';

interface Options {
  base?: boolean
  darkTheme?: boolean
  logs?: boolean // ignored
  prefix?: string
  styled?: boolean
  themeRoot?: string // :root
  themes?: string[]
  utils?: boolean
  variablePrefix?: string
}

const CSSCLASS = /\.(?<name>[-\w\P{ASCII}]+)/gu,
  NOMERGE = /^file-input(?:-.+)?|.*::-webkit-slider-runnable-track$/;

type ParentUnoSymbols = Partial<{
  [symbols.layer]: string
  [symbols.parent]: string
  [symbols.selector]: string
}>;

class NodesToFlatten {
  atrules: AtRule[] = [];
  declarations: Declaration[] = [];
  rules: Rule[] = [];
}

function* flattenRules(nodes: ChildNode[], parentUnoSymbols: ParentUnoSymbols = {}): Generator<[ParentUnoSymbols, Declaration[]] | string> {
  for (const node of nodes) {
    if (node.type !== 'atrule' && node.type !== 'rule') {
      if (node.type !== 'comment') {
        // eslint-disable-next-line no-console
        console.warn('skipping', node.type);
      }
      continue;
    }

    if (!node.nodes || node.nodes.length === 0) {
      continue;
    }

    const unoSymbols = { ...parentUnoSymbols };
    let selector = ('selector' in node ? node.selector : '');

    if (node.type === 'atrule') {
      if (node.name === 'keyframes') {
        yield node.toString();
        continue;
      } else if (node.name === 'layer') {
        const layer = unoSymbols[symbols.layer] ?? '';
        unoSymbols[symbols.layer] = `${layer}${layer === '' ? '' : '.'}${node.params}`;
      } else {
        selector = `@${node.name}${node.raws.afterName ?? ' '}${node.params ?? ''}`;
      }
    }

    if (selector) {
      const previousSelector = unoSymbols[symbols.selector] ?? '';
      if (previousSelector && selector !== previousSelector) {
        const parent = unoSymbols[symbols.parent] ?? '';
        unoSymbols[symbols.parent] = `${parent}${parent ? ' $$ ' : ''}${previousSelector}`;
      }
      unoSymbols[symbols.selector] = selector;
    }

    const nodesToFlatten = new NodesToFlatten();
    node.nodes.forEach((n: ChildNode) => {
      const type = n.type;
      if (type === 'decl') {
        nodesToFlatten.declarations.push(n);
      } else if (type === 'atrule') {
        nodesToFlatten.atrules.push(n);
      } else if (type === 'rule') {
        nodesToFlatten.rules.push(n);
      }
    });

    if (nodesToFlatten.declarations.length) {
      yield ([unoSymbols, nodesToFlatten.declarations]);
    }

    yield* flattenRules(nodesToFlatten.atrules, unoSymbols);
    yield* flattenRules(nodesToFlatten.rules, unoSymbols);
  }
}

function getUnoCssElements(childNodes: ChildNode[], cssObjectInputsByClassToken: Map<string, CSSObjectInput[]>, layer?: string): Preflight[] {
  const preflights: Preflight[] = [];
  Array.from(flattenRules(childNodes))
    .forEach((rawElement, idx) => {
      if (typeof rawElement === 'string') {
        preflights.push({
          getCSS: () => rawElement,
          layer
        });
        return;
      }
      const [unoSymbols, declarations] = rawElement,
        { [symbols.parent]: parent = '', [symbols.selector]: selector = '' } = unoSymbols,

        classMatches = Array.from(
          [...parent.matchAll(CSSCLASS), ...selector.matchAll(CSSCLASS)],
          ([, name]) => name
        ),

        classTokens = new Set(classMatches);

      if (classTokens.size === 0) {
        throw new Error('why include this rule?');
      }

      for (const classToken of classTokens) {
        let cssObjectInputs = cssObjectInputsByClassToken.get(classToken);
        if (cssObjectInputs == null) {
          cssObjectInputs = [];
          cssObjectInputsByClassToken.set(classToken, cssObjectInputs);
        }
        cssObjectInputs.push({
          ...Object.fromEntries((declarations).map(({ important, prop, value }) => [prop, `${value}${important ? ' !important' : ''}`])),
          ...unoSymbols,
          [symbols.selector]: (currentSelector) =>
            selector === currentSelector
              ? selector
              : selector.replaceAll(CSSCLASS, (all, c) => {
                  return c === classToken ? currentSelector : all;
                }),
          [symbols.sort]: idx
        });
      };
    });
  return preflights;
}

export async function presetDaisy(options?: Options): Promise<Preset<Record<string, any>>> {
  const cssObjectInputsByClassToken = new Map<string, CSSObjectInput[]>(),
    processor = postcss({
      Once(root) {
        root.walkAtRules((atRule) => {
          if (atRule.name === 'starting-style' && atRule.parent?.type === 'rule') {
            let value = '{';
            (new Stringifier((str) => value += str)).body(atRule);
            value += '}';
            atRule.replaceWith(postcss.decl({ prop: `@${atRule.name}`, value }));
          }
        });
        const variablePrefix = options?.variablePrefix ?? 'un-';
        if (variablePrefix !== 'tw-') {
          root.walkDecls((decl) => {
            if (decl.prop.startsWith('--tw-')) {
              decl.prop = `--${variablePrefix}${decl.prop.substring(5)}`;
            }
            if (decl.value.includes('var(--tw-')) {
              decl.value = decl.value.replaceAll('var(--tw-', `var(--${variablePrefix}`);
            }
          });
        }
      },
      postcssPlugin: 'fix-css'
    }, Nesting as PluginCreator<never>),
    /*  no need for unocss/postcss, as there's no @apply, @screen, @theme in input. Otherwise:
    createPlugin({ configOrPath: {
      configFile: false,
      presets: [presetUno(), () => presetDaisy({
        ...userOptions,
        base: false,
        themes: false,
        utils: false
      })]
    } }); */
    // eslint-disable-next-line ts/no-unsafe-assignment
    { config, handler }: { config: Partial<Preset<Record<string, any>>>, handler: (arg: any) => void } = typeof daisyui === 'function' ? (daisyui as (o: any) => any)(options) : daisyui,
    preflightPromises: Promise<Preflight[]>[] = [],
    variants: Variant[] = [];
  handler({
    addBase(jsCss: Record<string, any>) {
      preflightPromises.push(Promise.resolve([{
        getCSS: async () => processor.process(parse(jsCss), { from: 'base', to: 'base' }).then((ast) => ast.toString()),
        layer: 'daisy'
      }]));
    },
    addComponents(jsCss: Record<string, any>) {
      preflightPromises.push(
        processor.process(parse(jsCss), { from: 'components', to: 'components' })
          .then((ast) => getUnoCssElements(ast.root.nodes, cssObjectInputsByClassToken, 'daisyui.component'))
      );
    },
    addUtilities(jsCss: Record<string, any>) {
      preflightPromises.push(
        processor.process(parse(jsCss), { from: 'utilities', to: 'utilities' })
          .then((ast) => getUnoCssElements(ast.root.nodes, cssObjectInputsByClassToken, 'daisyui.utility'))
      );
    },

    addVariant(name: string, selector: string | string[]) {
      variants.push(
        (matcher) => {
          if (!matcher.startsWith(`${name}:`)) {
            return matcher;
          }

          return {
            matcher: matcher.slice(name.length + 1),
            selector: (s) => {
              const variantSelector = Array.isArray(selector) ? selector.join('') : selector;
              return `${s}${variantSelector}`;
            }
          };
        }
      );
    },
    config: (key: `${string}.${keyof Options}`) => options?.[key.split('.')[1]] as Options[keyof Options] | undefined // for daisyui v4
  });

  const preflights = await Promise.all(preflightPromises).then((p) => p.flat()),
    rules: DynamicRule[] = [];
  for (const [classToken, cssObjectInputs] of cssObjectInputsByClassToken) {
    const noMerge = cssObjectInputs.some((cssObjectInput) => {
      const selector = cssObjectInput[symbols.selector] as (selector: string) => string;
      return cssObjectInput[symbols.selector] != null && NOMERGE.test(selector(`.${classToken}`));
    });
    rules.push([new RegExp(`^${classToken}$`), () => cssObjectInputs, {
      autocomplete: classToken,
      noMerge
    }]);
  }

  return {
    ...config,
    name: 'unocss-preset-daisy',
    preflights,
    rules,
    variants
  };
}
