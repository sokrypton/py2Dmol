# py2Dmol Web Interface - Main Viewer

The py2Dmol web interface is a zero-install 2D structure viewer that runs entirely in your browser. Everything below happens locally—no files are uploaded to a server.

## Getting Started

- Use **Fetch** to pull a structure from the PDB (4-character IDs) or AlphaFold DB (UniProt IDs).
- Use **Load Files** to drag and drop PDB/CIF/ENT files (zip archives are supported) or metadata such as `.json`, `.cst`, `.a3m`, `.fasta`, `.fa`, `.fas`, and `.sto`.
- Enable **Load as Frames** to treat multiple structures as a trajectory, and **Align Frames** to superpose them automatically.
- Use **Load Biounit** when you want the biological assembly from PDB files. Disable **Ignore Ligands** to keep hetero atoms.

## Saving and Restoring Sessions

- The **Save** button exports a `.py2dmol.json` (or `.zip`) state file containing all loaded objects, current colors, selections, MSAs, and contacts.
- Re-load the state file via **Load Files** to resume exactly where you left off.

## Loading MSAs

- Check **Load MSA** before fetching or uploading to associate MSA files with the currently selected structure. MSAs can come from AlphaFold downloads, local A3M/FASTA/STO files, or files bundled in a `.zip`.
- After an MSA is linked to a structure, coverage/identity sliders and entropy coloring update both the molecule and sequence views immediately. All chains sharing the same sequence reuse the filtered entropy values.
- You can also upload an MSA after a structure is already loaded by dropping the file (with **Load MSA** enabled); it will be matched to chains by sequence.
- For standalone MSA viewing without structures, use the [MSA Viewer](msa.html) page.

## Loading AlphaFold Server and ColabFold Results

The viewer supports loading complete results from **AlphaFold Server** and **ColabFold** predictions, including structures, PAE matrices, and MSAs.

### ZIP Archive Support

- Upload a ZIP file containing your prediction results. The viewer automatically extracts and matches:
  - **Structure files** (`.pdb`, `.cif`, `.ent`) - displayed in the 2D viewer
  - **PAE JSON files** (`.json` with predicted aligned error data) - displayed as an interactive PAE matrix
  - **MSA files** (`.a3m`, `.fasta`, `.fa`, `.fas`, `.sto`) - displayed in the MSA viewer with filtering options

### Automatic File Matching

- PAE JSON files are automatically matched to structure files by name (e.g., `structure.cif` pairs with `structure_pae.json`).
- MSA files are associated with structures when **Load MSA** is enabled.
- Files can be organized in subdirectories within the ZIP; the viewer processes each directory as a separate object.

### PAE Matrix Display

- When a PAE JSON file is detected and **Load PAE** is enabled, a PAE (Predicted Aligned Error) matrix is displayed below the structure viewer.
- The PAE matrix shows confidence in residue-residue distance predictions, with darker colors indicating higher confidence.
- Click and drag on the PAE matrix to select regions and highlight corresponding residues in the structure.
- The viewer supports multiple PAE JSON formats, including AlphaFold DB, AlphaFold Server, and ColabFold outputs.

### Example Workflow

1. Download results from AlphaFold Server or ColabFold as a ZIP file.
2. Enable **Load PAE** and **Load MSA** checkboxes.
3. Drag and drop the ZIP file into the viewer or use **Load Files**.
4. The viewer automatically loads the structure, displays the PAE matrix, and shows the MSA (if available).

## Loading Contact Restraints (`.cst`)

- Drop or select `.cst` files alongside structures to add residue-residue contacts. Supported formats:
  - `10 58 1.0` (zero-based position indices with required weight).
  - `10 58 1.0 red` (position indices with weight and optional color—supports color names like "red", "yellow", "blue", or hex codes like "#ff0000", or rgba like "rgba(255,0,0,0.8)").
  - `A 10 B 58 0.5` (chain ID + residue number with required weight).
  - `A 10 B 58 0.5 yellow` (chain ID + residue number with weight and optional color).
- **Weight is required** and scales the visual width of contact lines (higher weights = thicker lines). Weights are also stored for future use with contact map viewers and filtering.
- **Color is optional** and can be specified as a color name (red, green, blue, yellow, orange, purple, cyan, magenta, pink, brown, black, white, gray), hex code (#ff0000), or rgba format (rgba(255,0,0,0.8)). If not specified, contacts default to yellow.
- Lines starting with `#` are treated as comments and ignored.
- If you upload only metadata (MSA/PAE/contacts) with **Load Files**, the app prompts you to attach them to the currently selected object.
- Contacts are stored per object. Re-uploading a `.cst` replaces the previous contact set for that object.

## Tips and Troubleshooting

- **Entropy colors look gray**: Make sure an MSA is loaded and that entropy mode is selected. Adjust coverage/identity sliders to ensure enough sequences remain after filtering.
- **Fetching AlphaFold MSAs**: When providing a 4-character PDB ID, the app resolves it to a UniProt accession via PDBe and then downloads the AlphaFold alignment.
- **Performance**: Keep the canvas within reasonable sizes for instant feedback. The resize handle next to the viewer lets you increase or decrease the drawing area as needed.

## Related Documentation

- For standalone MSA viewing and analysis, see the [MSA Viewer README](MSA_README.md) or visit [msa.html](msa.html).

Need more help? Visit the [GitHub repository](https://github.com/sokrypton/py2Dmol) for full documentation and issue tracking.

