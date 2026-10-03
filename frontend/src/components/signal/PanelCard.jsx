import { Card, CardContent, Grid } from '@mui/material';

// The full-width compact card every panel on the main view sits in.
export default function PanelCard({ children }) {
  return (
    <Grid item xs={12}>
      <Card>
        <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
          {children}
        </CardContent>
      </Card>
    </Grid>
  );
}
