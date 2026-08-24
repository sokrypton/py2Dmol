from setuptools import setup, find_packages

setup(
    name='py2Dmol',
    version='1.7.0',
    author='sokrypton',
    author_email='so3@mit.edu',
    description='A Python library for visualizing protein structures in 2D.',
    long_description='A Python library for visualizing protein structures in 2D.',
    long_description_content_type='text/markdown',
    url='https://github.com/sokrypton/py2Dmol',
    packages=find_packages(),
    include_package_data=True,
    # EVERY RESOURCE viewer.py OPENS. It reads these by name through
    # importlib.resources, so a file missing here is not a degraded viewer - it
    # is a FileNotFoundError on the first show(), in the wheel only, where no
    # test in this repo runs. viewer-cartoon-gpu.min.js was missing and
    # viewer.py:1329 opens it unconditionally.
    #
    # There is no MANIFEST.in and no pyproject.toml, so include_package_data
    # above contributes nothing and this list is the whole of it.
    # tests/packaging.py builds a wheel and imports it, which is the only way
    # this list can be checked at all.
    package_data={
        'py2Dmol': [
            'resources/viewer.html',
            'resources/viewer-mol.min.js',
            'resources/viewer-cartoon.min.js',
            'resources/viewer-cartoon-gpu.min.js',
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
