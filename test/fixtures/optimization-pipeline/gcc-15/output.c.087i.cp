
IPA constant propagation start:

IPA structures before propagation:

Jump functions:
  Jump functions of caller  clamp/3:
  Jump functions of caller  sum_of_squares/2:

 Propagating constants:

Not considering clamp/3 for cloning; -fipa-cp-clone disabled.
Not considering sum_of_squares/2 for cloning; -fipa-cp-clone disabled.

overall_size: 17

IPA lattices after all propagation:

Lattices:
  Node: clamp/3:
    param [0]: BOTTOM
         ctxs: BOTTOM
         Bits unusable (BOTTOM)
         [unsupported_range] VARYING
        AGGS BOTTOM
    param [1]: BOTTOM
         ctxs: BOTTOM
         Bits unusable (BOTTOM)
         [unsupported_range] VARYING
        AGGS BOTTOM
    param [2]: BOTTOM
         ctxs: BOTTOM
         Bits unusable (BOTTOM)
         [unsupported_range] VARYING
        AGGS BOTTOM
  Node: sum_of_squares/2:
    param [0]: BOTTOM
         ctxs: BOTTOM
         Bits unusable (BOTTOM)
         [unsupported_range] VARYING
        AGGS BOTTOM
    param [1]: BOTTOM
         ctxs: BOTTOM
         Bits unusable (BOTTOM)
         [unsupported_range] VARYING
        AGGS BOTTOM

IPA decision stage:


IPA constant propagation end

Reclaiming functions:
Reclaiming variables:
Clearing address taken flags:
Symbol table:

clamp/3 (clamp)
  Type: function definition analyzed
  Visibility: externally_visible semantic_interposition public
  References: 
  Referring: 
  Availability: available
  Function flags: count:1073741824 (estimated locally) body
  Called by: 
  Calls: 
sum_of_squares/2 (sum_of_squares)
  Type: function definition analyzed
  Visibility: externally_visible semantic_interposition public
  References: 
  Referring: 
  Availability: available
  Function flags: count:118111600 (estimated locally) body
  Called by: 
  Calls: 

;; Function sum_of_squares (sum_of_squares, funcdef_no=1, decl_uid=2836, cgraph_uid=2, symbol_order=1)

Modification phase of node sum_of_squares/2
int sum_of_squares (const int * values, int count)
{
  int index;
  int total;
  long unsigned int _1;
  long unsigned int _2;
  const int * _3;
  int _4;
  int _10;

  <bb 2> [local count: 118111600]:
  goto <bb 4>; [100.00%]

  <bb 3> [local count: 955630224]:
  _1 = (long unsigned int) index_6;
  _2 = _1 * 4;
  _3 = values_9(D) + _2;
  _4 = *_3;
  _10 = _4 * _4;
  total_11 = total_5 + _10;
  index_12 = index_6 + 1;

  <bb 4> [local count: 1073741824]:
  # total_5 = PHI <0(2), total_11(3)>
  # index_6 = PHI <0(2), index_12(3)>
  if (index_6 < count_8(D))
    goto <bb 3>; [89.00%]
  else
    goto <bb 5>; [11.00%]

  <bb 5> [local count: 118111600]:
  return total_5;

}



;; Function clamp (clamp, funcdef_no=2, decl_uid=2847, cgraph_uid=3, symbol_order=2)

Modification phase of node clamp/3
int clamp (int value, int low, int high)
{
  int _1;
  int _5;

  <bb 2> [local count: 1073741824]:
  if (value_2(D) < low_3(D))
    goto <bb 4>; [34.00%]
  else
    goto <bb 3>; [66.00%]

  <bb 3> [local count: 708669600]:
  _5 = MIN_EXPR <value_2(D), high_4(D)>;

  <bb 4> [local count: 1073741824]:
  # _1 = PHI <low_3(D)(2), _5(3)>
  return _1;

}


