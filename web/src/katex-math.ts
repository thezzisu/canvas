import { defineComponent, h } from 'vue'
import katex from 'katex'

/** Comark math node; KaTeX's own error rendering keeps an invalid formula's source visible. */
export const KatexMath = defineComponent({
  props: { content: { type: String, required: true }, class: { type: String, default: '' } },
  setup(props) {
    return () => {
      const inline = props.class.includes('inline')
      const innerHTML = katex.renderToString(props.content, {
        throwOnError: false,
        displayMode: !inline,
      })
      return h(inline ? 'span' : 'div', { class: inline ? 'math inline' : 'math block', innerHTML })
    }
  },
})
