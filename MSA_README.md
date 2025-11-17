# py2Dmol MSA Viewer

The MSA Viewer is a standalone tool for visualizing and analyzing multiple sequence alignments (MSAs) without requiring a 3D structure. It runs entirely in your browser—no files are uploaded to a server.

## Getting Started

- **Fetch from AlphaFold DB**: Enter a PDB ID (4-character) or UniProt ID (6-10 characters) in the input field and click **Fetch**. The viewer will automatically resolve PDB IDs to UniProt accessions and download the corresponding MSA from AlphaFold DB.
- **Upload MSA Files**: Click **Choose MSA File** or drag and drop A3M, FASTA (.fasta, .fa, .fas), or STO files directly onto the page.

## Viewing Modes

The MSA Viewer offers three visualization modes:

- **MSA Mode**: Traditional multiple sequence alignment view showing all sequences with color-coded amino acids.
- **PSSM Mode**: Position-Specific Scoring Matrix visualization showing amino acid frequencies at each position.
- **Logo Mode**: WebLogo-style representation showing sequence conservation and information content.

Switch between modes using the dropdown menu in the viewer controls.

## Filtering Sequences

Use the **Filters** sliders to refine which sequences are displayed:

- **Coverage (cov)**: Minimum percentage of the query sequence that must be covered by a sequence to be included.
- **Identity (qid)**: Minimum percentage sequence identity to the query sequence.

The sequence count display shows how many sequences remain after filtering. Adjust these sliders in real-time to see immediate updates.

## Export Options

- **Save Fasta**: Export the filtered MSA as a FASTA file (available in MSA mode).
- **Save SVG**: Export the current visualization as an SVG image (available in PSSM and Logo modes).
- **Save CSV**: Export PSSM data as a CSV file (available in PSSM mode).

## Tips and Troubleshooting

- **No sequences shown**: Check that your coverage and identity filters aren't too restrictive. Try lowering both sliders.
- **Fetch fails**: Ensure you're using a valid PDB ID (4 characters) or UniProt ID (6-10 characters). PDB IDs are automatically converted to UniProt accessions.
- **File format issues**: Supported formats are A3M, FASTA (.fasta, .fa, .fas), and STO. Make sure your file uses one of these formats.

## Related Documentation

- For structure viewing with integrated MSA support, see the [Main Viewer README](MAIN_README.md) or visit [index.html](index.html).

Need more help? Visit the [GitHub repository](https://github.com/sokrypton/py2Dmol) for full documentation and issue tracking.

