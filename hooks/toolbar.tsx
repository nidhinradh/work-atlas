// The toolbar as the atlas draws it itself: coloured type on the HUD's ground, in a region that reports where it was
// clicked. It runs on the drawing surface, apart from the hooks module, and knows nothing but its props: the rows to
// draw, each item already placed. A click on an item is posted to the hooks module, which changes the view.
import type { ClientModule } from 'claude-code'

/** One word of the toolbar, placed: a control when it has an id; with none, a caption, or the title when it has a colour. */
type Item = { id: string; label: string; x: number; color: string; isOn: boolean; dot: string; ground: string }
type Props = { rows: Item[][]; ground: string; ink: string; dim: string; faint: string }
type State = { hover: string }

const widthOf = (item: Item): number => item.label.length + (item.dot === '' ? 0 : 2)

const Toolbar: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const hover = surface.state?.hover ?? ''

  const under = (x: number, y: number): Item | undefined =>
    props.rows[y]?.find(item => item.id !== '' && x >= item.x && x < item.x + widthOf(item) + 1)

  surface.onPointer(event => {
    const item = event.type === 'leave' ? undefined : under(event.x, event.y)
    if (event.type === 'down' && item !== undefined) surface.post({ press: item.id })
    const next = item?.id ?? ''
    if (next !== hover) surface.setState({ hover: next })
  })

  // With the focus (a click gives it), 1 to 4 pick a tab.
  surface.onKey(event => {
    const tab = ['overview', 'timeline', 'files', 'log'][Number(event.key) - 1]
    if (tab !== undefined && event.ctrl !== true && event.meta !== true) surface.post({ press: `tab:${tab}` })
  })

  // Say once that the region is alive: until then the hooks module keeps the surface's own buttons on show.
  if (surface.state === undefined) {
    surface.setState({ hover: '' })
    surface.post({ hello: true })
  }

  return (
    <Box flexDirection="column" backgroundColor={props.ground} width="100%">
      {props.rows.map(row => {
        // Each word stands in a box of its own width in cells, and the gaps are boxes too: where a word is drawn is
        // then where the pointer finds it, whatever font the surface sets the type in.
        let at = 0
        const cells = []
        for (const item of row) {
          if (item.x > at) cells.push(<Box width={item.x - at} flexShrink={0} />)
          const isHot = item.id !== '' && item.id === hover
          cells.push(
            <Box width={widthOf(item)} flexShrink={0} flexDirection="row" backgroundColor={item.ground !== '' ? item.ground : props.ground}>
              {item.dot !== '' ? [<Text mono color={item.dot}>{item.isOn ? '◉ ' : '● '}</Text>] : []}
              <Text
                mono
                wrap="truncate-end"
                bold={item.isOn}
                underline={item.id !== '' && item.ground === '' && (item.isOn || isHot)}
                color={item.id === '' ? (item.color !== '' ? item.color : props.faint) : item.isOn || (isHot && item.ground !== '') ? item.color : isHot ? props.ink : props.dim}
              >
                {item.label}
              </Text>
            </Box>,
          )
          at = item.x + widthOf(item)
        }
        return (
          <Box flexDirection="row" flexWrap="nowrap" height={1}>
            {cells}
          </Box>
        )
      })}
    </Box>
  )
}

export default Toolbar
