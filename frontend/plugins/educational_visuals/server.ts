import * as pluginAPI from '../../src/plugin-api.ts'
import {createEducationalVisualsPlugin} from '../../../packages/learning-client/src/visuals/plugin-package.ts'

export const plugin = createEducationalVisualsPlugin(pluginAPI)
export default plugin
