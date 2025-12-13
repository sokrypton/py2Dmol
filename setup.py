from setuptools import setup, find_packages

setup(
    name='py2Dmol',
    version='1.6.0',
    author='sokrypton',
    author_email='so3@mit.edu',
    description='A Python library for visualizing protein structures in 2D.',
    long_description='A Python library for visualizing protein structures in 2D.',
    long_description_content_type='text/markdown',
    url='https://github.com/sokrypton/py2Dmol',
    packages=find_packages(),
    include_package_data=True,
    package_data={
        'py2Dmol': [
            'resources/viewer.html',
            'resources/viewer-mol.min.js',
            'resources/viewer-pae.min.js',
            'resources/viewer-scatter.min.js',
        ],
    },
    license='BEER-WARE',
    classifiers=[
        'Programming Language :: Python :: 3',
        'Operating System :: OS Independent',
    ],
    python_requires='>=3.6',
    install_requires=[
        'numpy',
        'ipython',
        'gemmi',
    ],
)
