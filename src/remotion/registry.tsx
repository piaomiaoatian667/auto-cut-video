import {z} from 'zod';
import {BasicTitle} from './components/BasicTitle';

const BasicTitlePropsSchema = z.object({
  text: z.string().min(1).max(80),
}).strict();

export class ComponentRegistryError extends Error {
  constructor(readonly code: 'EDIT_COMPONENT_UNREGISTERED' | 'EDIT_COMPONENT_PROPS_INVALID', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ComponentRegistryError';
  }
}

export const componentRegistry = {
  'basic-title': {
    component: BasicTitle,
    propsSchema: BasicTitlePropsSchema,
  },
} as const;

export type RegisteredComponentId = keyof typeof componentRegistry;

const isRegisteredComponentId = (component: string): component is RegisteredComponentId =>
  Object.hasOwn(componentRegistry, component);

export const parseOverlayProps = (
  component: string,
  props: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isRegisteredComponentId(component)) {
    throw new ComponentRegistryError(
      'EDIT_COMPONENT_UNREGISTERED',
      `overlay component is not registered: ${component}`,
    );
  }

  const result = componentRegistry[component].propsSchema.safeParse(props);
  if (!result.success) {
    throw new ComponentRegistryError(
      'EDIT_COMPONENT_PROPS_INVALID',
      `overlay props are invalid for ${component}`,
      {cause: result.error},
    );
  }
  return result.data;
};
