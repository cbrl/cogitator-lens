// Copyright (c) 2018, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import {ParseFiltersAndOutputOptions} from './filters.interfaces.js';
import * as utils from '../ce-utils.js';

const findQuotes = /(.*?)("(?:[^"\\]|\\.)*")(.*)/;

export class AsmRegex {
    protected labelDef: RegExp;

    constructor() {
        this.labelDef = /^(?:.proc\s+)?([\w$.@]+|"[\w$.@]+"):/i;
    }

    static squashHorizontalWhitespace(line: string, atStart: boolean): string {
        const quotes = line.match(findQuotes);
        if (quotes) {
            return (
                AsmRegex.squashHorizontalWhitespace(quotes[1], atStart) +
                quotes[2] +
                AsmRegex.squashHorizontalWhitespace(quotes[3], false)
            );
        }
        return utils.squashHorizontalWhitespace(line, atStart);
    }

    static filterAsmLine(line: string, filters: ParseFiltersAndOutputOptions): string {
        if (!filters.trim) return line;
        return AsmRegex.squashHorizontalWhitespace(line, true);
    }
}
