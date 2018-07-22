// @flow
import { ipcRenderer } from 'electron';
import React, { Component, Fragment } from 'react';
import { Form, Text } from 'informed';
import { random } from 'lodash';
import styles from '../new-career.scss';


const validate = value => (
  value.length > 1 ? null : ''
);

type SquadState = {
  search: string
};

export default class SquadInformation extends Component<{}, SquadState> {
  state = {
    search: ''
  };

  static animals = ipcRenderer.sendSync( 'adjective-animal' )
    .map( item => ({
      name: item,
      skill: Math.round( random( 0.5, 1.5 ) * 100 ) / 100,
      transferValue: 0
    }) );

  render() {
    return (
      <Form
        id="squad"
        className={styles.container}
        onValueChange={search => this.setState({ ...search })}
      >
        {({ formState }) => (
          <Fragment>
            <section className={styles.content}>
              <h2 className={styles.subtitle}>
                {'Squad'}
              </h2>

              <div className={styles.fieldSet}>
                <Text
                  field="search"
                  id="search"
                  placeholder={'Search'}
                  value={this.state.search}
                  validateOnChange
                  validate={validate}
                />
              </div>
            </section>

            <section className={styles.wideContent}>
              <div className={styles.table}>
                <div className={styles.thead}>
                  <span>{'Name'}</span>
                  <span>{'Skill Level'}</span>
                  <span>{'Transfer Value'}</span>
                </div>
                <div className={styles.tbody}>
                  {SquadInformation.animals
                    .filter( value => value.name.toLowerCase().includes( this.state.search.toLowerCase() ) )
                    .map( ( item: Object, index: number ) => (
                      <div key={index} className={styles.row}>
                        <span>{item.name}</span>
                        <span>{item.skill}</span>
                        <span>{item.transferValue}</span>
                      </div>
                    ) )
                  }
                </div>
              </div>
            </section>
          </Fragment>
        )}
      </Form>
    );
  }
}