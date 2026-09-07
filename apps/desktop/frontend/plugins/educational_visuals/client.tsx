import {defineLearnFlowPluginClient, type PluginToolRendererProps} from '../../src/PluginToolResultView.tsx'
import VisualPluginArtifact, {type VisualArtifactHost} from '../../../../../packages/learning-client/src/visuals/VisualPluginArtifact'

function VisualWorkRenderer(props: PluginToolRendererProps & {artifactHost?: VisualArtifactHost}) {
  const value = props.objects.find(object => object.objectType === 'visual_work')?.value || props.result.payload || {}
  const reference = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return <VisualPluginArtifact reference={reference} result={props.result} host={props.artifactHost} onPrompt={props.onPrompt}/>
}
export default defineLearnFlowPluginClient({
  pluginId: 'educational_visuals', name: '图解与动画', icon: '◈',
  description: '按学习目标检索、生成和改编可交互作品，保存版本并围绕当前画面继续学习。',
  renderers: {visual_work: VisualWorkRenderer},
})
