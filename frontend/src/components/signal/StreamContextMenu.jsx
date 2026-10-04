import { ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material';
import { ContentCopy as CopyIcon } from '@mui/icons-material';
import axios from 'axios';
import { streamFrequency } from '../../utils/channels';
import { streamUrl } from '../../utils/streamUrl';

// Right-click menu on a program's Watch button. `contextMenu` is
// { mouseX, mouseY, program }, or null while the menu is closed.
export default function StreamContextMenu({ contextMenu, onClose, tunerStatus, region, channelMap, selectedDevice }) {
  const copyStreamUrl = async () => {
    // Close first: the menu goes away at once, whether or not the copy works
    const program = contextMenu?.program;
    onClose();

    const freq = streamFrequency(tunerStatus?.channel, region, channelMap);
    if (!program || !freq) return;
    try {
      const response = await axios.get(streamUrl(selectedDevice, 'url', { ch: freq, program: program.programNum }));
      await navigator.clipboard.writeText(response.data.url);
    } catch (error) {
      console.error('Failed to copy stream URL:', error);
    }
  };

  return (
    <Menu
      open={contextMenu !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={
        contextMenu !== null
          ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
          : undefined
      }
    >
      <MenuItem onClick={copyStreamUrl}>
        <ListItemIcon>
          <CopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Copy Stream URL</ListItemText>
      </MenuItem>
    </Menu>
  );
}
