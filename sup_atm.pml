#!/usr/bin/env pymol
cmd.load("sup.pdb", "structure1")
cmd.load("2hga_PDZ.pdb", "structure2")
hide all
set all_states, off
show cartoon, structure1 and c. A and ( i.   15 or i.   19 or i.   20 or i.   21 or i.   22 or i.   23 or i.   24 or i.   25 or i.   26 or i.   27 or i.   28 or i.   29 or i.   30 or i.   31 or i.   32 or i.   33 or i.   34 or i.   35 or i.   36 or i.   40 or i.   41 or i.   42 or i.   43 or i.   44 or i.   45 or i.   46 or i.   47 or i.   48 or i.   49 or i.   50 or i.   51 or i.   52 or i.   53 or i.   54 or i.   55 or i.   57 or i.   58 or i.   60 or i.   61 or i.   62 or i.   63 or i.   64 or i.   65 or i.   66 or i.   67 or i.   68 or i.   69 or i.   70 or i.   71 or i.   72 or i.   73 or i.   74 or i.   75 or i.   76 or i.   77 or i.   78 or i.   79 or i.   82 or i.   83 or i.   84 or i.   85 or i.   86 or i.   87 or i.   88 or i.   89 or i.   92 or i.   93 or i.   94 or i.   95 or i.   96 or i.   97 or i.   98 or i.   99 or i.  100 or i.  101)
show cartoon, structure2 and c. A and ( i.   23 or i.   24 or i.   25 or i.   26 or i.   27 or i.   28 or i.   29 or i.   30 or i.   31 or i.   32 or i.   33 or i.   34 or i.   35 or i.   36 or i.   37 or i.   38 or i.   39 or i.   40 or i.   41 or i.   42 or i.   43 or i.   44 or i.   45 or i.   46 or i.   47 or i.   48 or i.   49 or i.   50 or i.   51 or i.   52 or i.   53 or i.   54 or i.   55 or i.   56 or i.   57 or i.   58 or i.   59 or i.   60 or i.   61 or i.   62 or i.   63 or i.   64 or i.   65 or i.   66 or i.   67 or i.   68 or i.   69 or i.   70 or i.   73 or i.   74 or i.   75 or i.   76 or i.   77 or i.   78 or i.   79 or i.   80 or i.   81 or i.   82 or i.   83 or i.   84 or i.   85 or i.   86 or i.   87 or i.   88 or i.   89 or i.   90 or i.   91 or i.   99 or i.  100 or i.  101 or i.  102 or i.  103 or i.  104 or i.  105 or i.  106)
color blue, structure1
color red, structure2
set ribbon_width, 6
set stick_radius, 0.3
set sphere_scale, 0.25
set ray_shadow, 0
bg_color white
set transparency=0.2
zoom polymer and ((structure1 and c. A) or (structure2 and c. A))

